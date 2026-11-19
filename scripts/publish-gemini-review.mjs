import { renderFindingRecord } from './review-ledger.mjs';
import { saveSessionComment } from './session-comment.mjs';
import { ledgerOptions } from './session-store.mjs';
import { renderPendingHandoff } from './review-ledger.mjs';
import { finalReviewOutlook } from './continue-review.mjs';
import { REVIEW_BODY_MAX_BYTES, splitForParts, anchorFindings, assertPrUnmoved, staleMarkerIfMoved, escapeHtml, foldedDetails, githubJson, loadAnchors, pullUrl, requiredEnv as required, splitSummary } from './github-review-api.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyIncrementalResult,
  applyVerificationResult,
  chargeClaudeFallback,
  normalizeReviewResult,
  normalizeVerificationResult,
  openMaterialFindings,
  recordDismissed,
  recordUncertainFindings,
  renderSessionComment,
  unresolvedMaterialFindings,
} from './review-session-core.mjs';

export async function publishGeminiReview({ env = process.env, fetchImpl = fetch } = {}) {
  const target = required(env, 'TARGET_REPO');
  const parts = target.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid TARGET_REPO');
  const [owner, repo] = parts;
  const prNumber = Number(required(env, 'PR_NUMBER'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('Invalid PR_NUMBER');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  const sourceCommentId = required(env, 'SOURCE_COMMENT_ID');
  const contextRoot = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const plan = JSON.parse(fs.readFileSync(path.join(contextRoot, 'session-plan.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(required(env, 'REVIEW_PATH'), 'utf8'));
  const mode = plan.decision?.mode;
  if (!['incremental', 'verification'].includes(mode)) throw new Error('Gemini publisher requires an incremental or verification session');

  await assertPrUnmoved({ owner, repo, prNumber, baseSha, headSha, token: env.GH_TOKEN, fetchImpl });

  let normalized;
  let session;
  if (mode === 'incremental') {
    normalized = normalizeReviewResult(raw);
    if (!plan.session) throw new Error('Incremental review plan is missing the previously audited session');
    session = applyIncrementalResult({ session: plan.session, result: normalized, headSha });
  } else {
    normalized = normalizeVerificationResult(raw);
    if (!plan.session) throw new Error('Verification plan is missing durable prior session');
    session = applyVerificationResult({ session: plan.session, result: normalized, headSha });
  }

  // Successful publication clears only an earlier provider-unavailable stop.
  if (session.reviewFailure) {
    const { reviewFailure, ...recovered } = session;
    session = recovered;
  }

  // Only source-backed REJECTED candidates are settled. UNCERTAIN P0–P2
  // candidates are persisted with their own IDs and block READY until a
  // code-backed decision or an explicitly attested human risk acceptance.
  if (mode === 'incremental') {
    session = recordDismissed(session, raw._validation?.validations, headSha);
    session = recordUncertainFindings(session, raw._validation?.validations, headSha);
  }

  // Charge every completed Claude call separately, preserving reported versus
  // conservatively reserved spend. Never label a legacy amount as SDK-reported.
  for (const meta of [raw._meta, raw._validation?._meta]) {
    if (meta?.provider === 'claude' && Number.isFinite(meta.total_cost_usd) && meta.total_cost_usd > 0)
      session = chargeClaudeFallback(session, meta.total_cost_usd, meta.cost_source === 'reserve' ? 'reserve' : 'sdk');
  }

  // Every verification answer becomes a readable Verdict record on the PR, written before the handoff that closes the stage.
  const verdictRecords = mode === 'verification'
    ? normalized.verifications.map((entry) => ({
      finding: session.findings.find((f) => f.id === entry.findingId) ?? { id: entry.findingId },
      verdict: entry.status, head: headSha, kind: 'repair',
      range: plan.decision?.previousHead ? plan.decision.previousHead + '..' + headSha : null,
      reason: entry.reason ?? '', run: String(env.GITHUB_RUN_ID ?? ''),
    })).filter((entry) => ['FIXED', 'STILL_OPEN', 'UNCERTAIN', 'DISMISSED'].includes(entry.verdict))
    : [];
  let sessionBody = renderSessionComment(session, { sourceCommentIds: [sourceCommentId], finalReview: finalReviewOutlook({ session, headSha, sourceCommentId, planMode: mode }), orphanReconcile: plan.orphanReconcile });
  const pendingMarker = renderPendingHandoff({ session, sourceCommentId });
  const anchors = await loadAnchors({ owner, repo, prNumber, token: env.GH_TOKEN, fetchImpl });
  const newFindings = session.findings.slice(plan.session.findings.length);
  // The first comment of each thread is the readable Finding Record: location, failure condition, blocking flag and
  // the full fields, so the thread alone says what was found.
  const { inline, unanchored } = anchorFindings(anchors, newFindings, (finding) => renderFindingRecord(finding, { headSha }));

  const open = openMaterialFindings(session);
  const reviewKind = mode === 'incremental' ? 'Incremental' : 'Verification';
  const { visible: summaryHead, detail: summaryDetail } = splitSummary(normalized.summary);
  let body = '## ' + (raw._meta?.provider === 'claude' ? 'Claude' : 'Gemini') + ' ' + reviewKind + ' Review\n\n' + summaryHead;
  let detail = summaryDetail;
  if (mode === 'verification') {
    detail += '\n\n### Finding verification';
    for (const verdict of normalized.verifications) {
      detail += '\n- **' + verdict.findingId + ' — ' + verdict.status + '**: ' + verdict.reason;
    }
  }
  if (mode === 'incremental' && raw._validation) {
    const validations = Array.isArray(raw._validation.validations) ? raw._validation.validations : [];
    const count = (verdict) => validations.filter((entry) => entry.verdict === verdict).length;
    detail += '\n\n### Material finding validation';
    if (raw._validation.status === 'SKIPPED') {
      detail += '\nNo P0/P1/P2 candidate required targeted validation.';
    } else {
      detail += '\n**Confirmed:** ' + count('CONFIRMED')
        + ' · **Rejected:** ' + count('REJECTED')
        + ' · **Uncertain:** ' + count('UNCERTAIN');
      for (const entry of validations) {
        const title = entry.title ? ' — ' + entry.title : '';
        detail += '\n- **' + (entry.candidateId || '?') + ' · ' + (entry.severity || '?')
          + ' · ' + (entry.verdict || 'UNCERTAIN') + '**' + title + ': ' + (entry.reason || '');
      }
    }
  }

  // Show exactly what the ledger dropped so a human can spot a wrong match.
  const suppressed = [
    ...(Array.isArray(raw._ledgerSuppressed) ? raw._ledgerSuppressed : []),
    ...droppedFindings(normalized.findings, newFindings),
  ];
  if (suppressed.length) {
    detail += '\n\n### Not re-raised (matched concerns already examined in this session)';
    for (const item of suppressed.slice(0, 6)) {
      detail += '\n- <code>' + escapeHtml(item.path) + '</code> — ' + escapeHtml(item.title);
    }
    detail += '\n_If one of these is actually a different bug, comment `@jiaze-claude-review-bot reset review`._';
  }
  const demoted = newFindings.filter((finding) => finding.downgradedFrom);
  for (const finding of demoted) {
    detail += '\n\n_' + finding.id + ' was reported as ' + finding.downgradedFrom
      + ' but gave no concrete failure path, so it is recorded as non-blocking P3._';
  }
  if (newFindings.length === 0) body += '\n\nNo new material finding was reported.';
  let unanchoredSection = '';
  if (unanchored.length) {
    unanchoredSection = '### Findings without an inline anchor';
    for (const finding of unanchored) {
      const location = finding.path + (finding.line ? ':' + finding.line : '');
      unanchoredSection += '\n- **[' + finding.id + ' · ' + finding.severity + '] ' + finding.title + '** — <code>'
        + escapeHtml(location) + '</code>: ' + finding.body;
    }
  }
  const unresolved = unresolvedMaterialFindings(session);
  body += '\n\n### Session result\n**' + session.status + '** · confirmed open material findings: **' + open.length
    + '** · unresolved material candidates: **' + unresolved.length
    + '** · verification passes so far: **' + session.verificationRound + '**';
  if (unresolved.length) {
    body += '\n\n**Not merge-ready:** targeted validation could not settle ' + unresolved.length
      + ' P0–P2 candidate(s). Inspect and adjudicate the F-numbered candidates with code evidence; they are not confirmed defects.';
  } else if (session.status === 'HUMAN_REQUIRED') {
    body += '\n\nAutomatic review has stopped. Human judgment is required before merger.';
  }
  detail += formatRuntime(raw._meta, mode === 'verification' ? 'Verification runtime' : 'Incremental runtime');
  detail += formatRuntime(raw._validation?._meta, 'Validation runtime');
  // The details are the one part that can grow without bound. If everything does not fit in the review itself, the
  // review keeps its summary and the details continue in numbered comments right after it: nothing is cut.
  const reportParts = [];
  const folded = foldedDetails('Review details (for AI)', detail);
  const reserveBytes = Buffer.byteLength('\n\n' + pendingMarker + '\n\n_The rest of this report continues in 99 comments right below (Part 1/99 onward)._', 'utf8');
  const whole = [unanchoredSection, folded].filter(Boolean).join('\n\n');
  if (!whole || Buffer.byteLength(body + '\n\n' + whole, 'utf8') + reserveBytes <= REVIEW_BODY_MAX_BYTES) {
    if (whole) body += '\n\n' + whole;
  } else {
    // Only the part that does not fit moves: the verdict, the session result and the headline stay in the review.
    const pieces = splitForParts([unanchoredSection, detail].filter(Boolean).join('\n\n'), 50_000);
    pieces.forEach((piece, index) => reportParts.push(foldedDetails(`Report · Part ${index + 1}/${pieces.length}`, piece)));
    body += `\n\n_The rest of this report (${[unanchoredSection && 'findings without an inline anchor', detail && 'review details'].filter(Boolean).join(' and ')}) continues in ${reportParts.length} comment${reportParts.length === 1 ? '' : 's'} right below (Part 1/${reportParts.length} onward)._`;
  }
  // This is intentionally NOT the processed-source marker. If durable session
  // persistence fails after the review POST, a retry remains eligible and can
  // recover this exact already-paid result without another Gemini call.
  body += '\n\n' + pendingMarker;
  if (Buffer.byteLength(body, 'utf8') > REVIEW_BODY_MAX_BYTES) throw new Error('Constructed review body exceeds safe size limit');

  const review = await githubJson(pullUrl({ owner, repo, prNumber }) + '/reviews',
    env.GH_TOKEN, fetchImpl, {
      method: 'POST',
      body: JSON.stringify({ commit_id: headSha, event: 'COMMENT', body, comments: inline }),
    });

  for (const [index, part] of reportParts.entries()) {
    await githubJson(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, env.GH_TOKEN, fetchImpl, {
      method: 'POST',
      body: JSON.stringify({ body: `### Review Report · Part ${index + 1}/${reportParts.length} · review ${review.id}\n\n${part}` }),
    });
  }

  // The review is already posted as threads on the reviewed commit. A push that arrived meanwhile must not make its
  // result vanish: record it for the reviewed commit, marked out of date for the newer one (that commit then plans
  // from it, e.g. verifies the open findings). Nothing is ever recorded as the status of the newer HEAD.
  const stale = await staleMarkerIfMoved({ owner, repo, prNumber, headSha, token: env.GH_TOKEN, fetchImpl });
  if (stale) {
    session = { ...session, ...stale };
    sessionBody = renderSessionComment(session, { sourceCommentIds: [sourceCommentId], finalReview: finalReviewOutlook({ session, headSha, sourceCommentId, planMode: mode }), orphanReconcile: plan.orphanReconcile });
    console.log('PR moved while publishing; recording the review for the reviewed commit, marked out of date.');
  }

  const sessionCommentId = await saveSessionComment({
    target: owner + '/' + repo, prNumber, existingId: plan.sessionCommentId, previous: plan.session, session, body: sessionBody, token: env.GH_TOKEN, fetchImpl,
    ledger: ledgerOptions(env, { sourceCommentIds: [sourceCommentId], expectedSeq: plan.ledgerSeq, spendThisRun: spentThisRun(raw), verdicts: verdictRecords }),
  });
  const publishedStatePath = path.join(contextRoot, 'published-session.json');
  fs.writeFileSync(publishedStatePath, JSON.stringify({
    mode, session, sessionCommentId, reviewId: review.id,
  }, null, 2) + '\n', { mode: 0o600 });
  console.log('Published Gemini ' + mode + ' review ' + (review.html_url || review.id)
    + '; session comment ' + sessionCommentId + '; status ' + session.status + '.');
  return { session, sessionCommentId, reviewId: review.id };
}

// What this run cost, from the usage the provider reported (zero for a provider that reports none).
function spentThisRun(raw) {
  return [raw?._meta, raw?._validation?._meta].reduce((sum, meta) => sum + (meta?.provider === 'claude' && Number.isFinite(meta.total_cost_usd) ? meta.total_cost_usd : 0), 0);
}

// Findings the session filter removed. Identity is path + title: two findings
// may share a title in different files, and only one of them may be dropped.
export function droppedFindings(reported, kept) {
  const key = (finding) => String(finding.path).replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
    + '\0' + String(finding.title).replace(/[\r\n]+/g, ' ').trim().slice(0, 140);
  const keptKeys = new Set(kept.map(key));
  return reported
    .filter((finding) => !keptKeys.has(key(finding)))
    .map((finding) => ({ title: finding.title, path: finding.path }));
}

function formatRuntime(meta, label = 'Review runtime') {
  if (!meta || typeof meta !== 'object') return '';
  const usage = meta.usage || {};
  const parts = [
    'model ' + escapeHtml(meta.resolved_model || meta.requested_model || 'Gemini'),
    'thinking ' + escapeHtml(meta.effort || 'low'),
  ];
  if (usage.input_tokens != null) parts.push('input ' + Number(usage.input_tokens).toLocaleString('en-US'));
  if (usage.output_tokens != null) parts.push('output ' + Number(usage.output_tokens).toLocaleString('en-US'));
  if (usage.thoughts_tokens != null) parts.push('thoughts ' + Number(usage.thoughts_tokens).toLocaleString('en-US'));
  if (meta.fallback_from) parts.push('fallback from ' + escapeHtml(meta.fallback_from) + ' (' + escapeHtml(meta.fallback_reason || 'unavailable') + ')');
  if (meta.risk_profile?.stateIntegrity === true) parts.push('risk state-integrity');
  return '\n\n' + (label === 'Discovery runtime' ? '---\n' : '') + '<sub>' + label + ': ' + parts.join(' · ') + '</sub>';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await publishGeminiReview();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
