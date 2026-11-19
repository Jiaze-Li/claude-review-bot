import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDiscoveryResult, renderSessionComment } from '../scripts/review-session-core.mjs';
import { createFakePr } from './helpers/fake-pr.mjs';
import { runDeepReviewCommand } from '../scripts/deep-review.mjs';
import { buildLedger, renderHandoffParts, runSpendFromCharges, runSpendUnrecorded } from '../scripts/review-ledger.mjs';
import { writeSessionRecords } from '../scripts/session-store.mjs';
import { publishGeminiReview } from '../scripts/publish-gemini-review.mjs';
import { beginDeepReview, completeDeepReview } from '../scripts/review-session-core.mjs';

const BOT_LOGIN = 'jiaze-claude-review-bot[bot]';
const BASE = 'b'.repeat(40), A = 'a'.repeat(40);
const T0 = '2026-10-16T08:00:00.000Z';
const isRecord = (body) => /^### Review (Receipt|Handoff|Run Start|Pending Handoff)/.test(String(body ?? ''));

function readySession(head = A) {
  return { ...applyDiscoveryResult({ result: { summary: 'ok', findings: [] }, baseSha: BASE, headSha: head, sourceCommentId: '1' }), status: 'READY', auditCompleted: true };
}

function fakeGitHub({ head = A, base = BASE, session = null } = {}) {
  const pr = createFakePr({ author: BOT_LOGIN, number: 7 });
  const existing = session ?? readySession();
  pr.seed(existing);
  pr.addIssue(renderSessionComment(existing), { id: 300 });
  const layered = pr.layer(async (url) => {
    if (/\/pulls\/7$/.test(url)) return Response.json({ base: { sha: base }, head: { sha: head } });
    if (/\/compare\//.test(url)) return Response.json({ ahead_by: 2 });
    assert.fail('unexpected ' + url);
  });
  return { fetchImpl: layered, pr };
}

// The Spend line of the newest closing Handoff on the PR.
function spendLine(gh) {
  const handoffs = gh.pr.issue.map((c) => c.body).filter((b) => /^### Review Handoff/.test(b) && /Handoff: COMPLETE/.test(b));
  assert.ok(handoffs.length, 'a closing Handoff was written');
  const line = handoffs.at(-1).split('\n').find((l) => l.startsWith('Spend:'));
  assert.ok(line, 'the Handoff has a Spend line');
  return line;
}

function ctxDir(plan, usage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify(plan));
  if (usage) fs.writeFileSync(path.join(dir, 'claude-usage.json'), JSON.stringify(usage));
  return dir;
}
const cenv = (dir, extra = {}) => ({
  TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, SOURCE_COMMENT_ID: '55',
  GH_TOKEN: 't', EXPECTED_REVIEW_AUTHOR: BOT_LOGIN, REVIEW_CONTEXT_DIR: dir, GITHUB_OUTPUT: path.join(dir, 'out'), ...extra,
});

async function fullReview(usage, { fail = false } = {}) {
  const gh = fakeGitHub();
  const dir = ctxDir({ requestedMode: 'claude', decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' }, usage);
  const env = cenv(dir);
  await runDeepReviewCommand('begin', { env, fetchImpl: gh.fetchImpl, now: T0 });
  if (fail) {
    await runDeepReviewCommand('fail', { env: { ...env, DEEP_REVIEW_FAILURE_REASON: 'boom' }, fetchImpl: gh.fetchImpl, now: T0 });
  } else {
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ summary: 'fine', findings: [] }));
    await runDeepReviewCommand('finalize', { env: { ...env, REVIEW_PATH: path.join(dir, 'review.json') }, fetchImpl: gh.fetchImpl, now: T0 });
  }
  return gh;
}

test('AC-01/02: a full review that cost $0.2065 does not show this run as $0.00 (the #103/#104 failure)', async () => {
  const gh = await fullReview({ subtype: 'success', total_cost_usd: 0.2065 });
  const line = spendLine(gh);
  assert.match(line, /this run \$0\.2065 \(SDK-reported\)/);
  assert.doesNotMatch(line, /this run \$0\.00/);
});

const handoffLine = (parts) => parts.at(-1).split('\n').find((l) => l.startsWith('Spend:'));
const closing = (extra) => renderHandoffParts({ session: { ...readySession(), deepSpendUsd: 0.21 }, stage: 'closing', seq: 2, ...extra });

test('AC-03: each cost state has its own wording, and a missing value is never read as $0.00', () => {
  assert.equal(handoffLine(closing({ runSpend: runSpendFromCharges([{ amount: 0.2065, source: 'sdk' }]) })),
    'Spend: this run $0.2065 (SDK-reported) / cumulative $0.21 (Claude charged ledger)');
  assert.equal(handoffLine(closing({ runSpend: runSpendFromCharges([{ amount: 0.004, source: 'sdk' }]) })),
    'Spend: this run $0.0040 (SDK-reported) / cumulative $0.21 (Claude charged ledger)');
  assert.match(handoffLine(closing({ runSpend: runSpendFromCharges([{ amount: 1, source: 'reserve' }]) })), /this run \$1\.0000 \(reserved: usage not reported\)/);
  assert.match(handoffLine(closing({ runSpend: runSpendFromCharges([{ amount: 0.2, source: 'sdk' }, { amount: 0.9, source: 'reserve' }], { unknownCalls: 1 }) })),
    /this run \$1\.1000 \(SDK-reported \$0\.2000 \+ reserved \$0\.9000 — usage not reported\) \+ 1 call\(s\) with unknown usage, not charged/);
  assert.match(handoffLine(closing({ runSpend: runSpendFromCharges([], { modelCalled: false }) })), /this run \$0\.00 \(no model call\)/);
  assert.match(handoffLine(closing({ runSpend: runSpendFromCharges([], { unknownCalls: 2 }) })), /this run unknown \(Claude usage not reported; nothing charged\)/);
  assert.match(handoffLine(closing({ runSpend: runSpendUnrecorded('because') })), /this run not recorded \(because\)/);
  // nothing given: not recorded, and certainly not $0.00
  const none = handoffLine(closing({}));
  assert.match(none, /this run not recorded/);
  assert.doesNotMatch(none, /\$0\.00 /);
});

test('the old numeric spendThisRun is refused instead of silently reading as a charge or as zero', async () => {
  assert.throws(() => closing({ spendThisRun: 0.2 }), /spendThisRun is retired/);
  assert.throws(() => closing({ runSpend: 0.2 }), /bare number/);
  await assert.rejects(() => writeSessionRecords({ target: 'a/b', prNumber: 7, token: 't', botLogin: BOT_LOGIN, session: readySession(), spendThisRun: 0.2 }), /spendThisRun is retired/);
});

test('AC-04: a Handoff written before this change (no cost wording) still reads as the same ledger', () => {
  const [body] = closing({ runSpend: runSpendFromCharges([{ amount: 0.2, source: 'sdk' }]) });
  const oldBody = body.replace(/^Spend: .*$/m, 'Spend: this run $0.00 / cumulative $0.21');
  const read = (text) => buildLedger({ records: [{ id: '10', source: 'issue', createdAt: '2026-10-16T08:00:00Z', body: text, login: BOT_LOGIN, type: 'Bot', lastEditedAt: null, minimizedReason: null }], botLogin: BOT_LOGIN, reads: { complete: true } });
  const fresh = read(body); const old = read(oldBody);
  assert.equal(old.state, fresh.state);
  assert.equal(old.handoff?.seq, fresh.handoff?.seq);
  assert.equal(old.handoff?.next, fresh.handoff?.next);
});

test('AC-02: a sub-cent cost is not rounded away, an SDK $0 run is a reported zero, and a missing usage file is the reserve', async () => {
  assert.match(spendLine(await fullReview({ subtype: 'success', total_cost_usd: 0.004 })), /this run \$0\.0040 \(SDK-reported\)/);
  assert.match(spendLine(await fullReview({ subtype: 'success', total_cost_usd: 0 })), /this run \$0\.00 \(SDK reported \$0\.00\)/);
  const reserve = await fullReview(null);
  assert.match(spendLine(reserve), /this run \$5\.0000 \(reserved: usage not reported\)/);
});

test('AC-04/05: a failed full review reports what it was charged; its status and cumulative are exactly what they were', async () => {
  const gh = await fullReview({ total_cost_usd: 1.2 }, { fail: true });
  assert.match(spendLine(gh), /this run \$1\.2000 \(SDK-reported\) \/ cumulative \$1\.20/);
  assert.equal(gh.pr.session().status, 'HUMAN_REQUIRED');
  assert.equal(gh.pr.session().deepSpendUsd, 1.2);
});

test('AC-05: finalizing the same usage twice leaves the cumulative and the wording unchanged', async () => {
  const gh = fakeGitHub();
  const dir = ctxDir({ requestedMode: 'claude', decision: { mode: 'claude' }, session: readySession(), sessionCommentId: '300' }, { subtype: 'success', total_cost_usd: 0.2065 });
  const env = cenv(dir);
  await runDeepReviewCommand('begin', { env, fetchImpl: gh.fetchImpl, now: T0 });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ summary: 'fine', findings: [] }));
  const finalizeEnv = { ...env, REVIEW_PATH: path.join(dir, 'review.json') };
  const first = await runDeepReviewCommand('finalize', { env: finalizeEnv, fetchImpl: gh.fetchImpl, now: T0 });
  const firstLine = spendLine(gh);
  // a retried finalize replays the saved state of the begin step: the same charge, never a second one
  const second = await runDeepReviewCommand('finalize', { env: finalizeEnv, fetchImpl: gh.fetchImpl, now: T0 }).catch((error) => error);
  assert.ok(second instanceof Error, 'the finished review cannot be finalized and charged again');
  assert.match(second.message, /does not match the in-progress session/);
  assert.equal(first.deepSpendUsd, 0.2065);
  assert.equal(gh.pr.session().deepSpendUsd, 0.2065);
  assert.equal(spendLine(gh), firstLine);
});

// ---- the Gemini publisher: only Claude calls in the review are charged ----
const OLD = 'd'.repeat(40);
async function publish(meta, validationMeta) {
  const first = applyDiscoveryResult({ result: { summary: 'clean', findings: [] }, baseSha: BASE, headSha: OLD, sourceCommentId: '1' });
  const baseline = completeDeepReview({ session: beginDeepReview({ session: first, baseSha: BASE, headSha: OLD }), result: { summary: 'clean', findings: [], coverage: { complete: true, unreviewedPaths: [] } }, headSha: OLD });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-gemini-'));
  fs.writeFileSync(path.join(dir, 'session-plan.json'), JSON.stringify({ decision: { mode: 'incremental', previousHead: OLD }, session: baseline, sessionCommentId: null }));
  const reviewPath = path.join(dir, 'review.json');
  fs.writeFileSync(reviewPath, JSON.stringify({ summary: 'clean', findings: [], _meta: meta, ...(validationMeta ? { _validation: { validations: [], _meta: validationMeta } } : {}) }));
  const pr = createFakePr();
  const fetchImpl = pr.layer(async (url) => {
    if (url.endsWith('/pulls/7')) return Response.json({ base: { sha: BASE }, head: { sha: A } });
    if (url.includes('/pulls/7/files')) return Response.json([]);
    if (url.endsWith('/pulls/7/reviews')) return Response.json({ id: 202 });
    assert.fail('unexpected URL ' + url);
  });
  const out = await publishGeminiReview({
    env: { GH_TOKEN: 't', TARGET_REPO: 'acme/project', PR_NUMBER: '7', BASE_SHA: BASE, HEAD_SHA: A, SOURCE_COMMENT_ID: '99', REVIEW_PATH: reviewPath, REVIEW_CONTEXT_DIR: dir, EXPECTED_REVIEW_AUTHOR: BOT_LOGIN },
    fetchImpl,
  });
  return { out, pr };
}

test('AC-04: Gemini publish reports Claude SDK and reserve charges, unknown usage, and a Gemini-only run each as what they are', async () => {
  const sdk = await publish({ provider: 'claude', total_cost_usd: 0.12, cost_source: 'sdk' });
  assert.match(spendLine(sdk), /this run \$0\.1200 \(SDK-reported\) \/ cumulative \$0\.12/);
  assert.equal(sdk.out.session.deepSpendUsd, 0.12);

  const reserve = await publish({ provider: 'claude', total_cost_usd: 2, cost_source: 'reserve' });
  assert.match(spendLine(reserve), /this run \$2\.0000 \(reserved: usage not reported\)/);

  const mixed = await publish({ provider: 'claude', total_cost_usd: 0.3, cost_source: 'sdk' }, { provider: 'claude', total_cost_usd: 1, cost_source: 'reserve' });
  assert.match(spendLine(mixed), /this run \$1\.3000 \(SDK-reported \$0\.3000 \+ reserved \$1\.0000 — usage not reported\)/);
  assert.equal(mixed.out.session.deepSpendUsd, 1.3);

  // Claude ran but reported nothing and nothing could be reserved: nothing is charged (unchanged), and it is not shown as free
  const unknown = await publish({ provider: 'claude', total_cost_usd: null, cost_source: 'unknown' });
  assert.match(spendLine(unknown), /this run unknown \(Claude usage not reported; nothing charged\)/);
  assert.equal(unknown.out.session.deepSpendUsd ?? 0, 0);

  const gemini = await publish({ provider: 'gemini', resolved_model: 'gemini-3.8-flash' });
  assert.match(spendLine(gemini), /this run \$0\.00 \(Gemini only, no Claude charge\)/);
});
