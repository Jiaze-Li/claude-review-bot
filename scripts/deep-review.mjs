import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { postCommitStatus } from './sync-commit-status.mjs';
import {
  CLAUDE_AUTO_MIN_BUDGET_USD,
  DEEP_REVIEW_MANUAL_RUN_BUDGET_USD,
  DEEP_REVIEW_RUN_BUDGET_USD,
  beginDeepReview,
  claudeFallbackCallBudget,
  completeDeepReview,
  failDeepReview,
  isDeepReviewStale,
  renderSessionComment,
} from './review-session-core.mjs';

// Explicit `@claude review` joins the durable review session:
//   begin    -> session becomes REVIEW_IN_PROGRESS for this exact HEAD (never READY meanwhile)
//   finalize -> Claude findings merge into the session ledger; READY only if nothing material is open
//   fail     -> any failure/timeout/budget exhaustion ends in HUMAN_REQUIRED
// Every step refuses to touch durable state if the PR HEAD moved.

export async function runDeepReviewCommand(command, { env = process.env, fetchImpl = fetch, now = new Date().toISOString() } = {}) {
  const ctx = readContext(env);
  const stateFile = path.join(ctx.contextRoot, 'deep-review-state.json');

  if (command === 'begin') {
    if (ctx.plan.decision?.mode !== 'claude') throw new Error('begin requires an explicit Claude deep review plan');
    await assertHeadUnmoved(ctx, fetchImpl);
    // An explicit @claude review (or a manual @gemini review comment) deliberately authorizes a
    // bounded $5 call even when the cumulative automatic $6 cap is exhausted. The same mode is
    // also chosen automatically when a PR is too large for Gemini; that run obeys the cap.
    const explicitClaude = ctx.plan.requestedMode === 'claude';
    const manual = explicitClaude || env.SOURCE_KIND === 'comment';
    let runBudget = manual
      ? DEEP_REVIEW_MANUAL_RUN_BUDGET_USD
      : Math.min(DEEP_REVIEW_MANUAL_RUN_BUDGET_USD, claudeFallbackCallBudget(ctx.plan.session, { manual: false }));
    // Gemini first (it is cheaper and billed to its own key); Claude takes over what Gemini cannot
    // finish. An explicit @claude review asks for Claude only. When this PR's automatic Claude
    // allowance is spent, Gemini alone can still review; it is not charged to that ledger.
    let providers = explicitClaude ? 'claude' : 'gemini,claude';
    if (!manual && runBudget < CLAUDE_AUTO_MIN_BUDGET_USD) {
      providers = 'gemini';
      runBudget = 0;
    }
    const session = beginDeepReview({
      session: ctx.plan.session, baseSha: ctx.baseSha, headSha: ctx.headSha, runId: env.GITHUB_RUN_ID,
      reserveUsd: runBudget, standalone: true, audit: ctx.plan.decision?.audit === true, now,
    });
    // Required status goes pending/error FIRST, so a failed durable write below can never leave an old green.
    await postCommitStatus({
      env, fetchImpl, target: ctx.target, headSha: ctx.headSha,
      status: { state: 'pending', description: 'Claude deep review in progress' },
    });
    const commentId = await upsertSession(ctx, session, [], fetchImpl, false);
    fs.writeFileSync(stateFile, JSON.stringify({ session, sessionCommentId: commentId }) + '\n', { mode: 0o600 });
    output(env, 'began', 'true');
    output(env, 'run', 'true');
    output(env, 'run_budget_usd', runBudget.toFixed(2));
    output(env, 'providers', providers);
    console.log(`Deep review begun (providers: ${providers.replace(',', ' then ')}; Claude per-call budget ${runBudget.toFixed(2)}).`);
    return session;
  }

  if (command === 'finalize') {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const result = JSON.parse(fs.readFileSync(required(env, 'REVIEW_PATH'), 'utf8'));
    const usage = readUsage(ctx.contextRoot, allottedBudget(env));
    await assertHeadUnmoved(ctx, fetchImpl);
    const session = completeDeepReview({
      session: state.session, result, headSha: ctx.headSha, spentUsd: usage.cost, costSource: usage.source, now,
    });
    await upsertSession(ctx, session, [ctx.sourceCommentId], fetchImpl, false, state.sessionCommentId);
    fs.writeFileSync(stateFile, JSON.stringify({ session, sessionCommentId: state.sessionCommentId }) + '\n', { mode: 0o600 });
    console.log(`Deep review merged into session; status ${session.status}.`);
    return session;
  }

  if (command === 'fail') {
    // Only two cases may fail a session: the run begun by THIS job died (local state file),
    // or the plan found a genuinely stale marker from a dead run. Anything else could be
    // another live run's fresh marker and must be left alone.
    let session; let commentId; let fallbackCost;
    if (fs.existsSync(stateFile)) {
      ({ session, sessionCommentId: commentId } = JSON.parse(fs.readFileSync(stateFile, 'utf8')));
      fallbackCost = allottedBudget(env);
    } else if (ctx.plan.decision?.mode === 'deep_review_stale' && isDeepReviewStale(ctx.plan.session, Date.parse(now))) {
      session = ctx.plan.session; commentId = ctx.plan.sessionCommentId;
      fallbackCost = ctx.plan.session.deepReview?.reservedUsd ?? DEEP_REVIEW_RUN_BUDGET_USD;
    } else {
      console.log('No deep review owned by this job and no stale marker; nothing to fail.');
      return null;
    }
    const usage = readUsage(ctx.contextRoot, fallbackCost);
    if (!session || session.status !== 'REVIEW_IN_PROGRESS' || session.lastReviewedHead !== ctx.headSha) {
      console.log('No in-progress deep review for this HEAD to fail; nothing to do.');
      return null;
    }
    // If the PR moved, the stale marker is harmless: the new HEAD plans a fresh discovery.
    if (!(await headUnmoved(ctx, fetchImpl))) {
      console.log('PR moved; leaving the superseded in-progress marker for the new HEAD to replace.');
      return null;
    }
    const failed = failDeepReview({
      session, headSha: ctx.headSha, reason: env.DEEP_REVIEW_FAILURE_REASON || 'deep review did not complete', spentUsd: usage.cost, costSource: usage.source, now,
    });
    await upsertSession(ctx, failed, [ctx.sourceCommentId], fetchImpl, true, commentId);
    console.log(`Deep review failed closed: ${failed.deepReview.reason}`);
    return failed;
  }

  throw new Error(`Unknown deep-review command: ${command}`);
}

function readContext(env) {
  const target = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  if (!/^[1-9]\d*$/.test(prNumber)) throw new Error('Invalid PR_NUMBER');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  return {
    target, prNumber, contextRoot,
    baseSha: required(env, 'BASE_SHA'),
    headSha: required(env, 'HEAD_SHA'),
    sourceCommentId: required(env, 'SOURCE_COMMENT_ID'),
    token: required(env, 'GH_TOKEN'),
    plan: JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8')),
  };
}

// Unknown spend is charged at the run's allotted budget so timeouts/kills cannot dodge the per-PR cap.
function readUsage(contextRoot, fallbackCost) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(contextRoot, 'claude-usage.json'), 'utf8'));
    if (typeof value.total_cost_usd === 'number' && value.total_cost_usd > 0) return { cost: value.total_cost_usd, source: 'sdk' };
    // A finished run that never needed Claude (Gemini reviewed everything) really cost the ledger nothing.
    if (value.total_cost_usd === 0 && value.subtype === 'success') return { cost: 0, source: 'sdk' };
  } catch {
    // fall through
  }
  return { cost: fallbackCost, source: 'reserve' };
}

function allottedBudget(env) {
  if (env.DEEP_REVIEW_MAX_BUDGET_USD === undefined || env.DEEP_REVIEW_MAX_BUDGET_USD === '') return DEEP_REVIEW_MANUAL_RUN_BUDGET_USD;
  const value = Number(env.DEEP_REVIEW_MAX_BUDGET_USD);
  return Number.isFinite(value) && value >= 0 ? value : DEEP_REVIEW_MANUAL_RUN_BUDGET_USD;
}

async function headUnmoved(ctx, fetchImpl) {
  const pr = await github(`https://api.github.com/repos/${ctx.target}/pulls/${ctx.prNumber}`, ctx.token, fetchImpl);
  return pr.base?.sha === ctx.baseSha && pr.head?.sha === ctx.headSha;
}

async function assertHeadUnmoved(ctx, fetchImpl) {
  if (!(await headUnmoved(ctx, fetchImpl))) throw new Error('PR moved; refusing to change durable review state for a stale HEAD');
}

async function upsertSession(ctx, session, sourceCommentIds, fetchImpl, _terminal, existingId = ctx.plan.sessionCommentId) {
  const body = renderSessionComment(session, { sourceCommentIds });
  const endpoint = existingId
    ? `https://api.github.com/repos/${ctx.target}/issues/comments/${existingId}`
    : `https://api.github.com/repos/${ctx.target}/issues/${ctx.prNumber}/comments`;
  const result = await github(endpoint, ctx.token, fetchImpl, { method: existingId ? 'PATCH' : 'POST', body: JSON.stringify({ body }) });
  return String(result.id);
}

async function github(url, token, fetchImpl, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub API failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function output(env, name, value) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDeepReviewCommand(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
