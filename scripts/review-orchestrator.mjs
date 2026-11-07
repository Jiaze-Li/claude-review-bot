// Unified Review Orchestrator
// Consolidates execution primitives for Full, Incremental, and Verification review workflows:
// - Provider chain execution with fallback and circuit breaking
// - Bounded parallel worker pool
// - Deadline tracking and timeout budgeting
// - Claude budget reservation, concurrency waiting, and cost settlement
// - Diagnostic logging and failure provenance tracking
// - Normalized provider outcome contract

export class DeadlineTracker {
  constructor({ totalMs, minBufferMs = 60_000, nowFn = Date.now } = {}) {
    this.nowFn = nowFn;
    this.startedAt = this.nowFn();
    this.totalMs = totalMs;
    this.minBufferMs = minBufferMs;
  }

  timeLeftMs() {
    return Math.max(0, this.startedAt + this.totalMs - this.nowFn());
  }

  elapsedMs() {
    return Math.max(0, this.nowFn() - this.startedAt);
  }

  hasExpired() {
    return this.timeLeftMs() <= 0;
  }

  isNearExpiry(bufferMs = this.minBufferMs) {
    return this.timeLeftMs() < bufferMs;
  }

  timeoutForCall(safetyBufferMs = 30_000, maxCapMs = null) {
    const available = Math.max(1_000, this.timeLeftMs() - safetyBufferMs);
    return maxCapMs ? Math.min(maxCapMs, available) : available;
  }
}

export class CircuitBreaker {
  constructor({ maxConsecutiveFailures = 2, initialReason = null } = {}) {
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.offReason = initialReason;
    this.failureCount = 0;
  }

  get isOff() {
    return Boolean(this.offReason);
  }

  get reason() {
    return this.offReason;
  }

  trip(reason) {
    if (!this.offReason) {
      this.offReason = reason || 'circuit breaker tripped';
    }
  }

  recordFailure(reason) {
    this.failureCount += 1;
    if (this.failureCount >= this.maxConsecutiveFailures && !this.offReason) {
      this.trip(reason || `exceeded failure threshold of ${this.maxConsecutiveFailures}`);
    }
  }

  recordSuccess() {
    this.failureCount = 0;
  }
}

export class BudgetManager {
  constructor({
    getAvailableBudget,
    minStartingAllowanceUsd = 0.3,
    perCallCap = null,
    pollIntervalMs = 250,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowFn = Date.now,
  } = {}) {
    this.getAvailableBudget = getAvailableBudget;
    this.minStartingAllowanceUsd = minStartingAllowanceUsd;
    this.perCallCap = perCallCap;
    this.pollIntervalMs = pollIntervalMs;
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;

    this.inflightUsd = 0;
    this.inflightCount = 0;
    this.charges = [];
    this.totalSpentUsd = 0;
  }

  async acquireReservation({ deadlineTracker, minTimeLeftMs = 60_000 } = {}) {
    for (;;) {
      const available = this.getAvailableBudget(this.inflightUsd);
      if (available >= this.minStartingAllowanceUsd) {
        let cap = available;
        if (typeof this.perCallCap === 'function') {
          cap = this.perCallCap(available);
        } else if (typeof this.perCallCap === 'number' && Number.isFinite(this.perCallCap)) {
          cap = Math.min(available, this.perCallCap);
        }
        this.inflightUsd += cap;
        this.inflightCount += 1;
        const reservation = {
          cap,
          amount: cap,
          source: 'reserve',
          settled: false,
        };
        this.charges.push(reservation);
        return reservation;
      }

      const hasInflight = this.inflightCount > 0;
      const timedOut = deadlineTracker && deadlineTracker.timeLeftMs() < minTimeLeftMs;
      if (!hasInflight || timedOut) {
        return null;
      }
      await this.sleepFn(this.pollIntervalMs);
    }
  }

  settleReservation(reservation, { actualCostUsd = null, costSource = null, fallbackCostUsd = null } = {}) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this.inflightUsd = Math.max(0, this.inflightUsd - reservation.cap);
    this.inflightCount = Math.max(0, this.inflightCount - 1);

    const charged = Number.isFinite(actualCostUsd)
      ? actualCostUsd
      : (Number.isFinite(fallbackCostUsd) ? fallbackCostUsd : reservation.cap);

    reservation.amount = charged;
    reservation.source = costSource || (Number.isFinite(actualCostUsd) ? 'sdk' : 'reserve');
    this.totalSpentUsd += charged;
    return charged;
  }
}

export async function runBoundedPool({
  items,
  concurrency = 3,
  deadlineTracker = null,
  minTimeBufferMs = 60_000,
  workerFn,
  onStop = () => {},
}) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const actualConcurrency = Math.max(1, Math.min(concurrency, items.length));

  async function poolWorker() {
    while (nextIndex < items.length) {
      if (deadlineTracker && deadlineTracker.isNearExpiry(minTimeBufferMs)) {
        onStop(nextIndex, items.length);
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await workerFn(items[index], index);
      } catch (err) {
        results[index] = { ok: false, error: err?.message ?? String(err), provider: null };
      }
    }
  }

  await Promise.all(Array.from({ length: actualConcurrency }, () => poolWorker()));
  return results;
}

export function normalizeProviderOutcome({
  ok = false,
  provider = null,
  status = null,
  errorKind = 'none',
  error = null,
  errors = '',
  structured = null,
  meta = null,
  usage = null,
  costSource = null,
  totalCostUsd = null,
  duration = 0,
  fallbackReason = null,
  coverage = null,
  facts = null,
} = {}) {
  const rawUsage = usage || meta?.usage || {};
  const normalizedUsage = {
    input_tokens: Number.isFinite(rawUsage.input_tokens) ? rawUsage.input_tokens : 0,
    output_tokens: Number.isFinite(rawUsage.output_tokens) ? rawUsage.output_tokens : 0,
    cache_creation_input_tokens: Number.isFinite(rawUsage.cache_creation_input_tokens) ? rawUsage.cache_creation_input_tokens : 0,
    cache_read_input_tokens: Number.isFinite(rawUsage.cache_read_input_tokens) ? rawUsage.cache_read_input_tokens : 0,
    thoughts_tokens: Number.isFinite(rawUsage.thoughts_tokens) ? rawUsage.thoughts_tokens : null,
    total_tokens: Number.isFinite(rawUsage.total_tokens) ? rawUsage.total_tokens : null,
  };

  const cost = Number.isFinite(totalCostUsd)
    ? totalCostUsd
    : (Number.isFinite(meta?.total_cost_usd) ? meta.total_cost_usd : null);

  const resolvedCostSource = costSource || meta?.cost_source || (Number.isFinite(cost) ? 'sdk' : null);

  return {
    ok: Boolean(ok),
    provider,
    status: status ?? meta?.status ?? null,
    errorKind: errorKind || (ok ? 'none' : 'unknown'),
    error: error || (ok ? null : 'unknown error'),
    errors: errors || error || '',
    structured: structured || null,
    usage: normalizedUsage,
    costSource: resolvedCostSource,
    totalCostUsd: cost,
    duration: duration || meta?.duration_ms || 0,
    fallbackReason: fallbackReason || meta?.fallback_reason || null,
    coverage: coverage || structured?.coverage || null,
    facts: facts || null,
    meta: meta || null,
  };
}

export async function executeWorkUnit({
  unit,
  providers = ['gemini', 'claude'],
  geminiCircuitBreaker = null,
  budgetManager = null,
  deadlineTracker = null,
  executors = {},
  onPartialCoverage = null,
  logImpl = () => {},
} = {}) {
  const notes = [];
  for (let position = 0; position < providers.length; position += 1) {
    const provider = providers[position];

    if (provider === 'gemini') {
      if (geminiCircuitBreaker?.isOff) {
        notes.push(`gemini: ${geminiCircuitBreaker.reason}`);
        continue;
      }
      if (typeof executors.gemini !== 'function') {
        notes.push('gemini: executor not configured');
        continue;
      }
      const timeoutMs = deadlineTracker ? deadlineTracker.timeoutForCall(30_000) : 180_000;
      let rawOutcome;
      try {
        rawOutcome = await executors.gemini({ unit, timeoutMs });
      } catch (err) {
        rawOutcome = { ok: false, error: err?.message ?? String(err), kind: 'failed' };
      }

      if (rawOutcome.ok) {
        geminiCircuitBreaker?.recordSuccess();
        const normalized = normalizeProviderOutcome({
          ok: true,
          provider: 'gemini',
          structured: rawOutcome.structured,
          meta: rawOutcome.meta,
          usage: rawOutcome.usage || rawOutcome.meta?.usage,
          totalCostUsd: rawOutcome.totalCostUsd ?? rawOutcome.meta?.total_cost_usd ?? 0,
          costSource: rawOutcome.costSource ?? rawOutcome.meta?.cost_source ?? 'zero',
          duration: rawOutcome.duration || rawOutcome.meta?.duration_ms || 0,
          coverage: rawOutcome.structured?.coverage,
        });

        if (typeof onPartialCoverage === 'function') {
          const handled = await onPartialCoverage({
            result: normalized,
            unit,
            currentProvider: 'gemini',
            remainingProviders: providers.slice(position + 1),
            notes,
          });
          if (handled) return handled;
        }

        return notes.length ? { ...normalized, fellBackFrom: notes.join('; ') } : normalized;
      }

      if (rawOutcome.kind === 'unavailable' || rawOutcome.kind === 'config') {
        geminiCircuitBreaker?.trip(rawOutcome.error);
      } else {
        geminiCircuitBreaker?.recordFailure(rawOutcome.error);
      }
      notes.push(`gemini: ${rawOutcome.error}`);
      continue;
    }

    if (provider === 'claude') {
      if (typeof executors.claude !== 'function') {
        notes.push('claude: executor not configured');
        continue;
      }

      let reservation = null;
      if (budgetManager) {
        reservation = await budgetManager.acquireReservation({ deadlineTracker });
        if (!reservation) {
          notes.push('claude: Claude budget for this review is exhausted');
          continue;
        }
      }

      const timeoutMs = deadlineTracker ? deadlineTracker.timeoutForCall(30_000) : 180_000;
      const budgetUsd = reservation?.cap ?? null;
      let rawOutcome;
      try {
        rawOutcome = await executors.claude({ unit, timeoutMs, maxBudgetUsd: budgetUsd, reservation });
      } catch (err) {
        rawOutcome = { ok: false, error: err?.message ?? String(err), subtype: 'error' };
      }

      if (budgetManager && reservation) {
        budgetManager.settleReservation(reservation, {
          actualCostUsd: rawOutcome?.meta?.total_cost_usd ?? rawOutcome?.totalCostUsd,
          costSource: rawOutcome?.meta?.cost_source ?? rawOutcome?.costSource,
          fallbackCostUsd: rawOutcome?.fallbackCostUsd,
        });
      }

      const resolvedTotalCost = Number.isFinite(rawOutcome?.totalCostUsd)
        ? rawOutcome.totalCostUsd
        : (Number.isFinite(rawOutcome?.meta?.total_cost_usd)
          ? rawOutcome.meta.total_cost_usd
          : (reservation ? reservation.amount : null));

      const resolvedCostSource = rawOutcome?.costSource
        || rawOutcome?.meta?.cost_source
        || (reservation ? reservation.source : (Number.isFinite(resolvedTotalCost) ? 'sdk' : null));

      if (rawOutcome?.meta) {
        if (!Number.isFinite(rawOutcome.meta.total_cost_usd) && Number.isFinite(resolvedTotalCost)) {
          rawOutcome.meta.total_cost_usd = resolvedTotalCost;
        }
        if (!rawOutcome.meta.cost_source && resolvedCostSource) {
          rawOutcome.meta.cost_source = resolvedCostSource;
        }
      }

      if (rawOutcome.ok && rawOutcome.structured) {
        const normalized = normalizeProviderOutcome({
          ok: true,
          provider: 'claude',
          structured: rawOutcome.structured,
          meta: rawOutcome.meta,
          usage: rawOutcome.usage || rawOutcome.meta?.usage,
          totalCostUsd: resolvedTotalCost,
          costSource: resolvedCostSource,
          duration: rawOutcome.duration || rawOutcome.meta?.duration_ms || 0,
          coverage: rawOutcome.structured?.coverage,
          facts: rawOutcome.facts || null,
        });

        if (typeof onPartialCoverage === 'function') {
          const handled = await onPartialCoverage({
            result: normalized,
            unit,
            currentProvider: 'claude',
            remainingProviders: providers.slice(position + 1),
            notes,
          });
          if (handled) return handled;
        }

        return notes.length ? { ...normalized, fellBackFrom: notes.join('; ') } : normalized;
      }

      notes.push(`claude: ${rawOutcome.error || rawOutcome.errors || 'no structured output'}`);
      continue;
    }

    notes.push(`unknown provider: ${provider}`);
  }

  return normalizeProviderOutcome({
    ok: false,
    provider: null,
    error: notes.join('; ') || 'no provider available',
    errors: notes.join('; ') || 'no provider available',
    fallbackReason: notes.join('; ') || null,
  });
}
