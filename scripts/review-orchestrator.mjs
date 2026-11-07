// Unified Review Orchestrator
// Consolidates execution primitives for Full, Incremental, and Verification review workflows:
// - Provider chain execution with fallback and circuit breaking
// - Bounded parallel worker pool
// - Deadline tracking and timeout budgeting
// - Claude budget reservation, concurrency waiting, and cost settlement
// - Diagnostic logging and failure provenance tracking
// - Normalized provider outcome contract

import { defaultProviderRegistry } from './provider-adapter.mjs';

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
    return this.timeLeftMs() <= bufferMs;
  }

  timeoutForCall(safetyBufferMs = 30_000, maxCapMs = null) {
    const available = Math.max(1_000, this.timeLeftMs() - safetyBufferMs);
    return maxCapMs ? Math.min(maxCapMs, available) : available;
  }
}

export class CircuitBreaker {
  constructor({ maxConsecutiveFailures, maxFailures = 2, initialReason = null, initialStatus = 0 } = {}) {
    this.maxFailures = maxConsecutiveFailures ?? maxFailures;
    this.maxConsecutiveFailures = this.maxFailures;
    this.offReason = initialReason;
    this.offStatus = initialStatus;
    this.failureCount = 0;
  }

  get isOff() {
    return Boolean(this.offReason);
  }

  get reason() {
    return this.offReason;
  }

  get status() {
    return this.offStatus;
  }

  trip(reason, status = 0) {
    if (!this.offReason) {
      this.offReason = reason || 'circuit breaker tripped';
      this.offStatus = status || 0;
    }
  }

  recordFailure(reason, status = 0) {
    this.failureCount += 1;
    if (this.failureCount >= this.maxFailures && !this.offReason) {
      this.trip(reason || `exceeded failure threshold of ${this.maxFailures}`, status);
    }
  }

  recordSuccess() {
    // Cumulative failure accounting across review run matches original runner semantics;
    // does not reset failureCount.
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
    this._charges = [];
    this.totalSpentUsd = 0;
  }

  get charges() {
    return this._charges.map((c) => ({
      amount: c.amount,
      source: c.source,
    }));
  }

  get totalPendingUsd() {
    return this._charges.reduce((sum, c) => sum + (c.settled ? c.amount : c.cap), 0);
  }

  async acquireReservation({ deadlineTracker, minTimeLeftMs = 60_000 } = {}) {
    for (;;) {
      const pendingUsd = this.totalPendingUsd;
      const available = this.getAvailableBudget(pendingUsd);
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
        this._charges.push(reservation);
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

  cancelReservation(reservation) {
    if (!reservation || reservation.settled) return;
    reservation.settled = true;
    this.inflightUsd = Math.max(0, this.inflightUsd - reservation.cap);
    this.inflightCount = Math.max(0, this.inflightCount - 1);
    const idx = this._charges.indexOf(reservation);
    if (idx !== -1) {
      this._charges.splice(idx, 1);
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
  catchErrors = false,
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
      if (catchErrors) {
        try {
          results[index] = await workerFn(items[index], index);
        } catch (err) {
          results[index] = { ok: false, error: err?.message ?? String(err), provider: null };
        }
      } else {
        results[index] = await workerFn(items[index], index);
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
    status: status ?? meta?.status ?? (ok ? 'success' : 'failed'),
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
  circuitBreakers = {},
  budgetManager = null,
  budgetManagers = {},
  deadlineTracker = null,
  defaultTimeoutMs = null,
  executors = {},
  canExecute = {},
  onPartialCoverage = null,
  onClaudeBudgetBlocked = null,
  onBudgetBlocked = {},
  onClaudeError = null,
  onError = {},
  throwClaudeErrors = false,
  throwErrors = {},
  logImpl = () => {},
  providerRegistry = defaultProviderRegistry,
} = {}) {
  const notes = [];
  let lastFailure = geminiCircuitBreaker?.isOff
    ? { status: geminiCircuitBreaker.status, message: geminiCircuitBreaker.reason }
    : null;
  let lastOutcome = null;

  for (let position = 0; position < providers.length; position += 1) {
    const provider = providers[position];
    const descriptor = providerRegistry?.getDescriptor?.(provider);
    const policy = descriptor?.policy || {};
    const capabilities = descriptor?.capabilities || {};

    // 1. Circuit breaker check
    const breaker = circuitBreakers[provider]
      || (provider === 'gemini' ? geminiCircuitBreaker : null);
    if (breaker?.isOff) {
      notes.push(`${provider}: ${breaker.reason}`);
      continue;
    }

    // 2. Pre-execution guard
    if (typeof canExecute?.[provider] === 'function') {
      const canRun = canExecute[provider]();
      if (canRun !== true) {
        notes.push(`${provider}: ${typeof canRun === 'string' ? canRun : 'not available'}`);
        continue;
      }
    }

    // 3. Executor check
    const executor = executors[provider];
    if (typeof executor !== 'function') {
      notes.push(`${provider}: executor not configured`);
      continue;
    }

    // 4. Budget manager & reservation check
    const providerBudgetMgr = budgetManagers[provider]
      || (policy.budgetType === 'usd-ledger' ? budgetManager : (provider === 'claude' ? budgetManager : null));
    let reservation = null;
    if (providerBudgetMgr) {
      reservation = await providerBudgetMgr.acquireReservation({ deadlineTracker });
      if (!reservation) {
        if (provider === 'claude' && typeof onClaudeBudgetBlocked === 'function') {
          await onClaudeBudgetBlocked({
            notes,
            lastFailed: lastFailure,
          });
        } else if (typeof onBudgetBlocked?.[provider] === 'function') {
          await onBudgetBlocked[provider]({
            notes,
            lastFailed: lastFailure,
          });
        }
        notes.push(`${provider}: ${provider === 'claude' ? 'Claude' : provider} budget for this review is exhausted`);
        continue;
      }
    }

    // 5. Timeout calculation
    const fallbackTimeout = policy.defaultTimeoutMs ?? 180_000;
    const timeoutMs = deadlineTracker
      ? deadlineTracker.timeoutForCall(30_000, defaultTimeoutMs)
      : (defaultTimeoutMs ?? fallbackTimeout);
    const budgetUsd = reservation?.cap ?? null;

    // 6. Invoke executor
    let rawOutcome;
    try {
      rawOutcome = await executor({
        unit,
        timeoutMs,
        maxBudgetUsd: budgetUsd,
        reservation,
        notes,
        lastFailed: lastFailure,
        priorGeminiOutcome: lastOutcome,
        priorOutcome: lastOutcome,
      });
    } catch (err) {
      if (providerBudgetMgr && reservation && !reservation.settled) {
        providerBudgetMgr.settleReservation(reservation, { actualCostUsd: reservation.cap, costSource: 'reserve' });
      }
      if (provider === 'claude' && typeof onClaudeError === 'function') {
        await onClaudeError({ error: err, reservation, notes, lastFailed: lastFailure });
      } else if (typeof onError?.[provider] === 'function') {
        await onError[provider]({ error: err, reservation, notes, lastFailed: lastFailure });
      }
      const shouldThrow = (provider === 'claude' && throwClaudeErrors)
        || (throwErrors === true)
        || (throwErrors?.[provider] === true);
      if (shouldThrow) throw err;
      rawOutcome = {
        ok: false,
        error: err?.message ?? String(err),
        errors: err?.message ?? String(err),
        kind: 'failed',
        errorKind: 'execution',
        subtype: 'error',
      };
    }
    lastOutcome = rawOutcome;

    // 7. Handle skipped outcome
    if (rawOutcome.kind === 'skipped') {
      if (providerBudgetMgr && reservation && !reservation.settled) {
        providerBudgetMgr.cancelReservation(reservation);
      }
      notes.push(`${provider}: ${rawOutcome.error}`);
      continue;
    }

    // 8. Settle reservation on normal completion or failure
    if (providerBudgetMgr && reservation && !reservation.settled) {
      providerBudgetMgr.settleReservation(reservation, {
        actualCostUsd: rawOutcome?.meta?.total_cost_usd ?? rawOutcome?.totalCostUsd,
        costSource: rawOutcome?.meta?.cost_source ?? rawOutcome?.costSource,
        fallbackCostUsd: rawOutcome?.fallbackCostUsd ?? reservation.cap,
      });
    }

    // 9. Cost resolution
    const defaultZeroCost = (policy.budgetType === 'prepaid-credits' || (!providerBudgetMgr && !reservation && provider !== 'claude'));
    const resolvedTotalCost = Number.isFinite(rawOutcome?.totalCostUsd)
      ? rawOutcome.totalCostUsd
      : (Number.isFinite(rawOutcome?.meta?.total_cost_usd)
        ? rawOutcome.meta.total_cost_usd
        : (reservation ? reservation.amount : (defaultZeroCost ? 0 : null)));

    const resolvedCostSource = rawOutcome?.costSource
      || rawOutcome?.meta?.cost_source
      || (reservation ? reservation.source : (defaultZeroCost ? 'zero' : (Number.isFinite(resolvedTotalCost) ? 'sdk' : null)));

    if (rawOutcome?.meta) {
      if (!Number.isFinite(rawOutcome.meta.total_cost_usd) && Number.isFinite(resolvedTotalCost)) {
        rawOutcome.meta.total_cost_usd = resolvedTotalCost;
      }
      if (!rawOutcome.meta.cost_source && resolvedCostSource) {
        rawOutcome.meta.cost_source = resolvedCostSource;
      }
    }

    // 10. Success check
    const requiresStructured = capabilities.structuredOutput ?? (provider === 'claude');
    const hasRequiredStructure = !requiresStructured || (rawOutcome.structured != null);
    if (rawOutcome.ok && hasRequiredStructure) {
      breaker?.recordSuccess();

      const normalized = normalizeProviderOutcome({
        ok: true,
        provider,
        structured: rawOutcome.structured,
        meta: rawOutcome.meta,
        usage: rawOutcome.usage || rawOutcome.meta?.usage,
        totalCostUsd: resolvedTotalCost,
        costSource: resolvedCostSource,
        duration: rawOutcome.duration || rawOutcome.meta?.duration_ms || 0,
        coverage: rawOutcome.structured?.coverage || rawOutcome.coverage,
        facts: rawOutcome.facts || null,
        fallbackReason: notes.length ? notes.join('; ') : null,
      });

      if (typeof onPartialCoverage === 'function') {
        const handled = await onPartialCoverage({
          result: normalized,
          unit,
          currentProvider: provider,
          remainingProviders: providers.slice(position + 1),
          notes,
        });
        if (handled) return handled;
      }

      return notes.length ? { ...normalized, fellBackFrom: notes.join('; ') } : normalized;
    }

    // 11. Failure classification & breaker recording
    const status = rawOutcome.status || 0;
    if (breaker) {
      if (rawOutcome.kind === 'unavailable' || rawOutcome.kind === 'config') {
        breaker.trip(rawOutcome.error, status);
      } else {
        breaker.recordFailure(rawOutcome.error, status);
      }
    }

    lastFailure = { status, message: rawOutcome.error || rawOutcome.errors };
    notes.push(`${provider}: ${rawOutcome.error || rawOutcome.errors || 'no structured output'}`);
  }

  return normalizeProviderOutcome({
    ok: false,
    provider: null,
    errorKind: 'unavailable',
    error: notes.join('; ') || 'no provider available',
    errors: notes.join('; ') || 'no provider available',
    fallbackReason: notes.join('; ') || null,
  });
}
