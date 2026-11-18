import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveSessionComment } from './session-comment.mjs';
import { finalReviewOutlook } from './continue-review.mjs';
import {
  applyFindingDismissal,
  chargeClaudeFallback,
  checkDismissEligibility,
  isBlockingFinding,
  parseSessionComment,
  recordDismissAttempt,
  renderSessionComment,
} from './review-session-core.mjs';
import { fetchReviewThreads, replyToThread, threadsByFinding } from './review-threads.mjs';
import { verifyDismissalWithModel } from './dismiss-verifier.mjs';
import { parseDismissalRequest } from '../worker/src/review-trigger.js';

// Independent model verification for @gemini dismiss F001. All user-origin
// facts are re-fetched from GitHub rather than trusted from workflow_dispatch.
export async function applyManualDismissal({
  env = process.env,
  fetchImpl = fetch,
  modelFetchImpl = fetchImpl,
  queryImpl = null,
} = {}) {
  const repo = required(env, 'TARGET_REPO');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid TARGET_REPO');
  const prNumber = required(env, 'PR_NUMBER');
  const sourceId = required(env, 'SOURCE_COMMENT_ID');
  if (!/^[1-9]\d*$/.test(prNumber) || !/^[1-9]\d*$/.test(sourceId)) {
    throw new Error('Invalid PR or source comment ID');
  }
  if (env.SOURCE_KIND !== 'comment') throw new Error('Dismissal requires a human PR comment');
  const by = required(env, 'TRIGGER_USER');
  const expectedAuthor = required(env, 'EXPECTED_REVIEW_AUTHOR');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  if (!/^[0-9a-f]{40}$/i.test(baseSha) || !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error('Invalid exact PR SHA');

  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  if (plan.decision?.mode !== 'dismiss' || !plan.session || !/^[1-9]\d*$/.test(String(plan.sessionCommentId))) {
    throw new Error('Dismissal requires an existing unfinished durable session');
  }

  const root = 'https://api.github.com/repos/' + repo;
  const prUrl = root + '/pulls/' + prNumber;
  const proveHead = async () => {
    const pr = await github(prUrl, env.GH_TOKEN, fetchImpl);
    if (pr.state !== 'open' || pr.base?.sha !== baseSha || pr.head?.sha !== headSha) {
      throw new Error('PR moved or closed before finding dismissal');
    }
  };
  await proveHead();
  const source = await github(root + '/issues/comments/' + sourceId, env.GH_TOKEN, fetchImpl);
  if (String(source.id) !== sourceId
      || String(source.issue_url || '').toLowerCase() !== (root + '/issues/' + prNumber).toLowerCase()
      || String(source.user?.login || '').toLowerCase() !== by.toLowerCase()) {
    throw new Error('Dismissal source comment does not belong to this PR or actor');
  }
  const permission = await github(root + '/collaborators/' + encodeURIComponent(by) + '/permission', env.GH_TOKEN, fetchImpl);
  if (!['write', 'maintain', 'admin'].includes(permission.permission)) {
    throw new Error('Finding dismissal requires repository write permission');
  }

  let decision;
  try {
    decision = parseDismissalRequest(source.body);
  } catch (parseError) {
    await postInvalidDismissalReply({
      repo,
      prNumber,
      sourceId,
      heading: '**Dismissal command format invalid**',
      reason: String(parseError?.message || parseError),
      fetchImpl,
      env,
    });
    writePublishedSession(contextRoot, { mode: 'dismiss', verdict: 'INVALID', skippedModel: true, session: plan.session, sessionCommentId: plan.sessionCommentId });
    console.log(`Dismissal format invalid for comment ${sourceId}; posted guidance reply.`);
    return plan.session;
  }

  const loadCurrentDurable = async () => {
    const current = await github(root + '/issues/comments/' + plan.sessionCommentId, env.GH_TOKEN, fetchImpl);
    return String(current.user?.login || '') === expectedAuthor ? parseSessionComment(current.body) : null;
  };
  const durable = await loadCurrentDurable();
  if (!durable || JSON.stringify(durable) !== JSON.stringify(plan.session)) {
    throw new Error('Durable review session changed since planning; refusing stale dismissal');
  }

  const targetFinding = durable.findings.find((f) => f.id === decision.findingId);
  if (!targetFinding || !['OPEN', 'UNCERTAIN'].includes(targetFinding.status) || !isBlockingFinding(targetFinding)) {
    const openIds = durable.findings
      .filter((f) => ['OPEN', 'UNCERTAIN'].includes(f.status) && isBlockingFinding(f))
      .map((f) => f.id);
    const reason = !targetFinding
      ? `Finding **${decision.findingId}** was not found in this review session.${openIds.length ? ` Open blocking findings: ${openIds.join(', ')}.` : ''}`
      : !['OPEN', 'UNCERTAIN'].includes(targetFinding.status)
        ? `Finding **${decision.findingId}** is already **${targetFinding.status}** and does not need dismissal.`
        : `Finding **${decision.findingId}** is non-blocking (${targetFinding.severity}) and does not require dismissal.`;
    await postInvalidDismissalReply({
      repo,
      prNumber,
      sourceId,
      heading: `**${decision.findingId} cannot be dismissed**`,
      reason,
      fetchImpl,
      env,
    });
    writePublishedSession(contextRoot, { mode: 'dismiss', verdict: 'INVALID', skippedModel: true, session: durable, sessionCommentId: plan.sessionCommentId });
    console.log(`Dismissal target ${decision.findingId} ineligible; posted guidance reply.`);
    return durable;
  }

  const inputHash = createHash('sha256')
    .update(decision.reason.trim() + '\n' + decision.evidence.join('\n'))
    .digest('hex')
    .slice(0, 16);

  const eligibility = checkDismissEligibility({
    session: durable,
    findingId: decision.findingId,
    headSha,
    sourceCommentId: sourceId,
    inputHash,
  });

  if (!eligibility.eligible) {
    if (eligibility.kind === 'duplicate_comment') {
      console.log(`Dismissal comment ${sourceId} already processed; skipping.`);
      return durable;
    }
    const priorReason = eligibility.entry?.reason || 'Previous dismissal rebuttal on this HEAD was already rejected.';
    const message = eligibility.kind === 'duplicate_rebuttal'
      ? `Repeated identical rebuttal for **${decision.findingId}** on this commit was not re-run. ${priorReason}`
      : `Per-commit dismissal verification limit reached for **${decision.findingId}** on this commit without new code changes.`;
    const recorded = recordDismissAttempt({
      session: durable,
      findingId: decision.findingId,
      headSha,
      sourceCommentId: sourceId,
      inputHash,
      verdict: 'REJECTED',
      reason: message,
    });
    const body = renderSessionComment(recorded, {
      sourceCommentIds: [sourceId],
      finalReview: finalReviewOutlook({ session: recorded, headSha, sourceCommentId: env.SOURCE_COMMENT_ID, planMode: 'dismiss' }),
    });
    const savedId = await saveSessionComment({
      target: repo, prNumber, token: env.GH_TOKEN, fetchImpl,
      existingId: plan.sessionCommentId, previous: durable, session: recorded, body,
    });
    await postDismissalOutcomeReply({
      repo, prNumber, expectedAuthor, session: recorded, findingId: decision.findingId,
      heading: `**${decision.findingId} dismissal not re-run**`,
      reason: message,
      nextStep: 'Push a code/test fix, or have a repository maintainer use `override review` if accepting risk.',
      env, fetchImpl,
    });
    writePublishedSession(contextRoot, { mode: 'dismiss', verdict: 'REJECTED', skippedModel: true, session: recorded, sessionCommentId: savedId });
    return recorded;
  }

  const repoRoot = path.resolve(env.SAFE_REPO_DIR || env.TARGET_REPO_DIR || 'safe-target');
  const diffPath = path.join(contextRoot, 'pr.diff');
  const prDiff = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, 'utf8') : '';

  const verdict = await verifyDismissalWithModel({
    repo,
    prNumber,
    headSha,
    finding: targetFinding,
    reason: decision.reason,
    evidence: decision.evidence,
    session: durable,
    repoRoot,
    prDiff,
    env,
    fetchImpl: modelFetchImpl,
    githubFetchImpl: fetchImpl,
    queryImpl,
  });

  // Re-verify PR HEAD and durable session before writing any state (TOCTOU guard).
  // If either changed after Claude ran, persist the Claude spend best-effort on the
  // latest durable session before aborting so budget accounting is never lost.
  try {
    await proveHead();
    const latestDurable = await loadCurrentDurable();
    if (!latestDurable || JSON.stringify(latestDurable) !== JSON.stringify(durable)) {
      throw new Error('Durable review session changed during dismissal verification; refusing stale verdict');
    }
  } catch (staleError) {
    if (verdict.claudeCharge && Number.isFinite(verdict.claudeCharge.amount) && verdict.claudeCharge.amount > 0) {
      try {
        const latestForSpend = await loadCurrentDurable();
        if (latestForSpend) {
          const charged = chargeClaudeFallback(latestForSpend, verdict.claudeCharge.amount, verdict.claudeCharge.source || 'sdk');
          const chargedBody = renderSessionComment(charged, { sourceCommentIds: [sourceId] });
          await saveSessionComment({
            target: repo, prNumber, token: env.GH_TOKEN, fetchImpl,
            existingId: plan.sessionCommentId, previous: latestForSpend, session: charged, body: chargedBody,
          });
        }
      } catch {
        // Best-effort spend persistence must never mask the stale-state abort.
      }
    }
    throw staleError;
  }

  if (verdict.verdict === 'DISMISSED') {
    const session = applyFindingDismissal({
      session: durable,
      findingId: decision.findingId,
      headSha,
      by,
      reason: decision.reason,
      evidence: decision.evidence,
      sourceCommentId: sourceId,
      verification: verdict,
      inputHash,
    });
    const body = renderSessionComment(session, {
      sourceCommentIds: [sourceId],
      finalReview: finalReviewOutlook({ session, headSha, sourceCommentId: env.SOURCE_COMMENT_ID, planMode: 'dismiss' }),
    });
    const savedId = await saveSessionComment({
      target: repo, prNumber, token: env.GH_TOKEN, fetchImpl,
      existingId: plan.sessionCommentId, previous: durable, session, body,
    });
    writePublishedSession(contextRoot, { mode: 'dismiss', verdict: 'DISMISSED', session, sessionCommentId: savedId });
    console.log(`Verified dismissal recorded (${verdict.provider}): ${decision.findingId}; status ${session.status}.`);
    return session;
  }

  const session = recordDismissAttempt({
    session: durable,
    findingId: decision.findingId,
    headSha,
    sourceCommentId: sourceId,
    inputHash,
    verdict: verdict.verdict,
    reason: verdict.reason,
    unavailable: Boolean(verdict.unavailable),
    claudeCharge: verdict.claudeCharge,
  });
  const body = renderSessionComment(session, {
    sourceCommentIds: [sourceId],
    finalReview: finalReviewOutlook({ session, headSha, sourceCommentId: env.SOURCE_COMMENT_ID, planMode: 'dismiss' }),
  });
  const savedId = await saveSessionComment({
    target: repo, prNumber, token: env.GH_TOKEN, fetchImpl,
    existingId: plan.sessionCommentId, previous: durable, session, body,
  });

  const isRejected = verdict.verdict === 'REJECTED';
  await postDismissalOutcomeReply({
    repo,
    prNumber,
    expectedAuthor,
    session,
    findingId: decision.findingId,
    heading: isRejected
      ? `**${decision.findingId} dismissal rejected**`
      : `**${decision.findingId} dismissal inconclusive (kept blocking)**`,
    reason: verdict.reason,
    nextStep: verdict.nextStep,
    env,
    fetchImpl,
  });
  writePublishedSession(contextRoot, { mode: 'dismiss', verdict: verdict.verdict, session, sessionCommentId: savedId });
  console.log(`Dismissal ${verdict.verdict.toLowerCase()} for ${decision.findingId}; status ${session.status} remains blocking.`);
  return session;
}

const DISMISSAL_FORMAT_EXAMPLE = [
  '```text',
  '@gemini dismiss F001',
  'Reason: <30-1200 characters explaining why this finding is a false positive or already addressed>',
  'Evidence: <https://... or path/to/file.ext#L10>',
  '```',
].join('\n');

async function postInvalidDismissalReply({ repo, prNumber, sourceId, heading, reason, env, fetchImpl }) {
  const body = [
    `<!-- jiaze-review-source-comment:${sourceId} -->`,
    heading,
    '',
    reason,
    '',
    'Expected format:',
    DISMISSAL_FORMAT_EXAMPLE,
  ].join('\n');
  await github(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, env.GH_TOKEN, fetchImpl, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function postDismissalOutcomeReply({
  repo, prNumber, expectedAuthor, session, findingId, heading, reason, nextStep, env, fetchImpl,
}) {
  const token = env.THREAD_TOKEN || env.GH_TOKEN;
  const botLogin = expectedAuthor.replace(/\[bot\]$/, '');
  const [owner, repoName] = repo.split('/');
  const message = `${heading}\n\n${reason}${nextStep ? `\n\n**Next:** ${nextStep}` : ''}`;

  let postedInThread = false;
  try {
    const threads = await fetchReviewThreads({ owner, repo: repoName, number: Number(prNumber), token, fetchImpl });
    const byFinding = threadsByFinding({ session, threads, botLogin });
    const targetThread = (byFinding.get(findingId) ?? []).find((t) => Boolean(t.commentId));
    if (targetThread) {
      await replyToThread({
        target: repo,
        prNumber,
        commentId: targetThread.commentId,
        body: message,
        token,
        fetchImpl,
      });
      postedInThread = true;
    }
  } catch (error) {
    console.warn(`Could not reply in original review thread for ${findingId}: ${String(error?.message || error).slice(0, 200)}`);
  }

  if (!postedInThread) {
    await github(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, env.GH_TOKEN, fetchImpl, {
      method: 'POST',
      body: JSON.stringify({ body: message }),
    });
  }
}

function writePublishedSession(contextRoot, payload) {
  fs.writeFileSync(path.join(contextRoot, 'published-session.json'), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
}

async function github(url, token, fetchImpl, init = {}) {
  if (!token) throw new Error('Missing GH_TOKEN');
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('GitHub dismissal API failed (HTTP ' + response.status + ')');
  return response.json();
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error('Missing ' + key);
  return String(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await applyManualDismissal(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
