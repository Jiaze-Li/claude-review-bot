import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBlockingFinding, isDeepReviewStale, isFullMode, openMaterialFindings, planReviewSession, providerPolicyFor, scopeOfMode, unresolvedMaterialFindings } from './review-session-core.mjs';
import { LEDGER_CODES, loadLedger, pendingFromRecords } from './session-store.mjs';
import { dropIgnoredFiles, splitDiffByFile, stagedFixedBytes, stagedReviewCapacity } from './review-shards.mjs';
import { adoptOrphanFindings, blockingClaims, fetchReviewThreads, findOrphanBotThreads, isWriter, threadsByFinding } from './review-threads.mjs';
import { prepareIncrementalDelta } from './select-incremental-review.mjs';
import { chainIndex } from './continue-review.mjs';

const repoPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern=/^[0-9a-f]{40}$/i;
export const MAX_CARRIED_FINDINGS=8;

// The plan carries the scope of this review and, separately, which model policy applies (see review-session-core).
function withScopeAndPolicy(plan){
  return {...plan,providerPolicy:providerPolicyFor(plan.requestedMode),decision:{...plan.decision,scope:scopeOfMode(plan.decision?.mode)}};
}

export async function planSession(args={}) {
  return withScopeAndPolicy(await planSessionDecision(args));
}

async function planSessionDecision({ env=process.env, fetchImpl=fetch }={}) {
  const target=required(env,'TARGET_REPO');
  if(!repoPattern.test(target)) throw new Error('Invalid TARGET_REPO');
  const pr=required(env,'PR_NUMBER');
  if(!/^[1-9]\d*$/.test(pr)) throw new Error('Invalid PR_NUMBER');
  const baseSha=required(env,'BASE_SHA');
  const headSha=required(env,'HEAD_SHA');
  if(!shaPattern.test(baseSha)||!shaPattern.test(headSha)) throw new Error('Invalid PR SHA');
  const requested=(env.REQUESTED_MODE||'auto').toLowerCase();
  if(!['auto','claude','reset','override','dismiss','threads','stale'].includes(requested)) throw new Error('Invalid REQUESTED_MODE');

  const expectedAuthor=required(env,'EXPECTED_REVIEW_AUTHOR');
  // The review session is rebuilt from the bot's own readable records on the PR (see review-ledger.mjs). An old
  // hidden-state session is imported first. Anything unreadable, edited, incomplete or inconsistent stops here.
  const {ledger,records}=await loadLedger({target,prNumber:pr,token:env.GH_TOKEN,fetchImpl,botLogin:expectedAuthor,headSha});
  const ledgerSeq=ledger.handoff?.seq??0;
  const pending=pendingFromRecords(records,expectedAuthor);
  let session=null;
  let sessionCommentId=null;
  if(ledger.state==='stopped'){
    // A run that posted its review but died before closing the stage left a complete copy of its session inside
    // that review: finish the handoff from it, without another model call.
    if(ledger.code===LEDGER_CODES.STAGE_NOT_CLOSED && requested!=='reset' && pending && pending.session.lastReviewedHead===headSha){
      return {ledgerSeq,requestedMode:requested,decision:{mode:'recover',previousHead:null,reason:'the previous review stage never closed; completing its handoff from the review it already published (no model call)'},
        session:null,sessionCommentId:null,pendingSession:pending.session,pendingSourceCommentId:pending.sourceCommentId,pendingReviewId:pending.reviewId};
    }
    return {ledgerSeq,requestedMode:requested,decision:{mode:'human_required',previousHead:null,reason:ledger.message},
      session:null,sessionCommentId:null,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null,ledgerStopped:{code:ledger.code}};
  }
  session=ledger.session??null;
  sessionCommentId=ledger.projection?.id??null;
  if(requested!=='reset' && pending && pending.session.lastReviewedHead===headSha && isPendingNewer(session,pending.session)){
    return {
      ledgerSeq,
      requestedMode:requested,
      decision:{mode:'recover',previousHead:null,reason:providerPolicyFor(requested)==='claude_only'
        ?'recover published review session without another model call. Your @claude review request was NOT run; send it again after this recovery.'
        :requested==='threads'
          ?'recover published review session without another model call. Your review-thread decision was NOT applied yet; resolve the thread again (or comment @gemini review) after this recovery.'
          :'recover published review session without another model call'},
      session,
      sessionCommentId,
      pendingSession:pending.session,
      pendingSourceCommentId:pending.sourceCommentId,
      pendingReviewId:pending.reviewId,
    };
  }

  // A person resolved or reopened one of the bot's review threads. Resolving is a claim ("I fixed this"), not a
  // verdict: once every blocking finding has been resolved by a writer and there are new commits to look at, the
  // normal verification review runs (Gemini first, Claude continues) and only its result decides READY. Anything
  // else is reconciled without a model call (non-blocking threads; threads put back when nothing was pushed).
  // If a review is running right now its own run will write the session; leave it be.
  if(requested==='threads'){
    const wait=(reason)=>({mode:'noop_waiting',previousHead:session?.lastReviewedHead??null,reason});
    let decision;
    if(!session) decision=wait('there is no review session for this PR yet');
    else if(session.status==='REVIEW_IN_PROGRESS') decision=wait('a review is running; resolve the thread again, or comment @gemini review, once it has finished');
    else{
      decision={mode:'threads',previousHead:null,reason:'a person resolved or reopened a review thread; reconciling the session with the threads'};
      if(session.lastReviewedHead!==headSha && env.GH_TOKEN){
        const [owner,repoName]=target.split('/');
        const botLogin=expectedAuthor.replace(/\[bot\]$/,'');
        const threads=await fetchReviewThreads({owner,repo:repoName,number:Number(pr),token:env.GH_TOKEN,fetchImpl});
        const claims=blockingClaims({session,byFinding:threadsByFinding({session,threads,botLogin}),botLogin});
        if(claims.allClaimed){
          const resolvers=new Set(threads.flatMap(t=>t.isResolved&&t.resolvedBy?.login&&t.resolvedBy.login!==botLogin?[t.resolvedBy.login]:[]));
          let allWriters=resolvers.size>0;
          for(const login of resolvers) if(!(await isWriter({target,login,token:env.GH_TOKEN,fetchImpl}))) allWriters=false;
          const planned=allWriters?planReviewSession({session,baseSha,headSha,reset:false,retryUnavailable:false}):null;
          if(planned?.mode==='verification') decision={...planned,reason:`every blocking finding was resolved by a person; ${planned.reason}`};
        }
      }
    }
    return {ledgerSeq,requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  // A push. Never reviews and never spends: it only marks a result for an older commit as out of date, once.
  // The newest result may be a pending recovery or a running review; those write the session themselves.
  if(requested==='stale'){
    const already=session&&session.staleFor===session.lastReviewedHead&&session.staleHead===headSha;
    const decision=!session
      ?{mode:'noop_waiting',previousHead:null,reason:'there is no review session for this PR yet'}
      :session.status==='REVIEW_IN_PROGRESS'
        ?{mode:'noop_waiting',previousHead:session.lastReviewedHead,reason:'a review is running; it will record its own result'}
        :session.lastReviewedHead===headSha
          ?{mode:'noop_waiting',previousHead:headSha,reason:'this commit is the one that was reviewed'}
          :already
            ?{mode:'noop_waiting',previousHead:session.lastReviewedHead,reason:'the review result is already marked out of date for this commit'}
            :{mode:'stale',previousHead:session.lastReviewedHead,reason:'a new commit was pushed after the last review; marking that result as out of date (no model call)'};
    return {ledgerSeq,requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  // `@claude review` plans exactly like `@gemini review` (first review, incremental, verification or final
  // audit, whatever the session calls for); only the model differs: Claude alone instead of Gemini first.
  // A run still in progress for this exact HEAD is the one thing to wait for rather than start again.
  if(['claude','reset'].includes(requested) && session && session.lastReviewedHead===headSha && session.status==='REVIEW_IN_PROGRESS' && !isDeepReviewStale(session)){
    const decision={mode:'noop_waiting',previousHead:headSha,reason:'a full review is already in progress for this HEAD'};
    return {ledgerSeq,requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  if(requested==='dismiss'){
    const alreadyHandled=Boolean(env.SOURCE_COMMENT_ID) && Array.isArray(session?.dismissLedger)
      && session.dismissLedger.some(entry=>String(entry?.commentId??'')===String(env.SOURCE_COMMENT_ID));
    const eligible=!alreadyHandled && session && ['REWORK','HUMAN_REQUIRED'].includes(session.status)
      && session.findings.some(f=>['OPEN','UNCERTAIN'].includes(f.status) && isBlockingFinding(f));
    const decision=alreadyHandled
      ?{mode:'noop_waiting',previousHead:null,reason:'this dismissal comment was already adjudicated'}
      :eligible
        ?{mode:'dismiss',previousHead:null,reason:'adjudicate one evidenced finding without bypassing final audit'}
        :{mode:'noop_waiting',previousHead:null,reason: !session
          ? 'there is no review session for this PR yet'
          : !['REWORK','HUMAN_REQUIRED'].includes(session.status)
            ? `review session is ${session.status}, not REWORK or HUMAN_REQUIRED`
            : 'no OPEN or UNCERTAIN blocking finding remains to dismiss'};
    return {ledgerSeq,requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  if(requested==='override'){
    const overridable=session&&['REWORK','HUMAN_REQUIRED','AUDIT_PENDING','PARTIAL'].includes(session.status);
    const decision=overridable
      ?{mode:'override',previousHead:null,reason:'manual override by a repository writer'}
      :{mode:'noop_waiting',previousHead:null,reason:'nothing to override: no unfinished review session for this PR'};
    return {ledgerSeq,requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  let decision=planReviewSession({session,baseSha,headSha,reset:requested==='reset',
    retryUnavailable:['auto','claude'].includes(requested) && env.SOURCE_KIND==='comment',
    continuation:chainIndex(env.SOURCE_COMMENT_ID)>0});
  // One route for every full review, whatever its size, provider or purpose (a first review, a review after a big
  // or risky change, the final review before READY): the sharded engine, Gemini first, Claude continuing what Gemini
  // cannot. Only delta reviews (incremental, verification) use the staged pipeline.
  if(decision.mode==='full_review'){
    if(requested!=='reset' && session && session.lastReviewedHead!==headSha){
      const carried=openMaterialFindings(session).length+unresolvedMaterialFindings(session).length;
      if(carried>MAX_CARRIED_FINDINGS){
        decision={
          mode:'human_required',
          previousHead:session.lastReviewedHead,
          reason:`${carried} blocking findings are still open (more than the ${MAX_CARRIED_FINDINGS} that can be carried safely); comment "reset review" to discard the session or "override review" to waive them`,
        };
      }else{
        const hasOpen=openMaterialFindings(session).length>0;
        decision=fullReviewDecision(env,requested,decision.reason);
        if(hasOpen) decision={...decision,carryOpen:true};
      }
    }else{
      decision=fullReviewDecision(env,requested,decision.reason);
    }
  }
  return {ledgerSeq,requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
}


// Is the "last reviewed HEAD -> new HEAD" two-point diff still a fix delta? It is when the old HEAD is an ancestor of the
// new one and the PR's merge base with its target did not move (an ordinary fix push). After a rebase, force-push, a
// merge of the target branch into the PR branch or a changed base, that diff also holds unrelated history.
// Read-only (GitHub compare). "Cannot tell" throws; it is never treated as an ordinary delta.
export async function classifyReviewBaseline({ previousHead, headSha, baseSha, mergeBaseNow, target, token, fetchImpl = fetch }) {
  if (!shaPattern.test(String(mergeBaseNow ?? ''))) throw new Error('The current PR merge base is missing or invalid; refusing to guess the review scope');
  const compare = async (from, to) => {
    const response = await fetchImpl(`https://api.github.com/repos/${target}/compare/${from}...${to}?per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404 || response.status === 422) return null;
    if (!response.ok) throw new Error(`GitHub compare failed (HTTP ${response.status})`);
    return response.json();
  };
  const forward = await compare(previousHead, headSha);
  if (!forward) return { kind: 'rewritten', reason: 'the previously reviewed commit is no longer reachable' };
  if (['diverged', 'behind'].includes(forward.status)) return { kind: 'rewritten', reason: 'the PR was rebased or force-pushed since the last review' };
  if (!['ahead', 'identical'].includes(forward.status)) throw new Error(`Unexpected GitHub compare status: ${forward.status}`);
  const old = await compare(baseSha, previousHead);
  const mergeBaseOld = old?.merge_base_commit?.sha;
  if (!shaPattern.test(String(mergeBaseOld ?? ''))) return { kind: 'rewritten', reason: 'the previous review base can no longer be determined' };
  if (mergeBaseOld.toLowerCase() !== mergeBaseNow.toLowerCase()) return { kind: 'rewritten', reason: 'the target branch was merged into the PR branch, or the PR base changed, since the last review' };
  return { kind: 'delta', reason: 'ordinary fix commits on the same base' };
}

function readCurrentPrScope({ contextDir, session }) {
  const read = (name) => fs.readFileSync(path.join(contextDir, name), 'utf8');
  const prDiff = read('pr.diff');
  const ignoreFile = path.join(contextDir, 'ignore-patterns.txt');
  const diff = dropIgnoredFiles(prDiff, fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '');
  const riskFile = path.join(contextDir, 'risk-profile.json');
  const riskProfile = fs.existsSync(riskFile) ? JSON.parse(fs.readFileSync(riskFile, 'utf8')) : { version: 1, stateIntegrity: false, signals: { synchronization: [], durableState: [], multiActor: [] } };
  const capacity = stagedReviewCapacity({ diff, fixedBytes: stagedFixedBytes({ prJson: read('pr.json'), session, riskProfile }) });
  const chunks = splitDiffByFile(diff);
  return { prDiff, diff, chunks, capacity, files: chunks.length };
}

// Called once for a `verification` decision before it is used (the workflow's two-point diff is its default scope).
// Ordinary fix: decision unchanged. Rewritten history: verify against the whole current PR diff when that fits one
// staged review (the workflow then skips its own two-point diff because repair.diff already exists), else review the
// whole PR in shards with the old blocking findings carried as "needs confirmation". Never closes a finding itself.
export async function resolveVerificationScope({ plan, env = process.env, fetchImpl = fetch }) {
  const decision = plan.decision;
  if (decision?.mode !== 'verification' || !decision.previousHead) return plan.decision;
  const contextDir = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const baseSha = required(env, 'BASE_SHA');
  const headSha = required(env, 'HEAD_SHA');
  let mergeBaseNow;
  try { mergeBaseNow = fs.readFileSync(path.join(contextDir, 'merge-base.txt'), 'utf8').trim(); } catch { mergeBaseNow = ''; }
  const verdict = await classifyReviewBaseline({
    previousHead: decision.previousHead, headSha, baseSha, mergeBaseNow, target: required(env, 'TARGET_REPO'), token: env.GH_TOKEN, fetchImpl,
  });
  if (verdict.kind === 'delta') return decision;

  const { prDiff, capacity, files } = readCurrentPrScope({ contextDir, session: plan.session });
  const where = `base ${mergeBaseNow.slice(0, 7)}, head ${headSha.slice(0, 7)}`;
  if (capacity.kind !== 'too_large') {
    fs.mkdirSync(contextDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(contextDir, 'repair.diff'), prDiff, { mode: 0o600 });
    return {
      mode: 'verification', previousHead: decision.previousHead, scope: 'current-pr',
      reason: `PR history was rewritten since the last review (${verdict.reason}); verifying the open findings against the whole current PR diff (${files} files, ${where})`,
    };
  }
  const carried = openMaterialFindings(plan.session).length + unresolvedMaterialFindings(plan.session).length;
  if (carried > MAX_CARRIED_FINDINGS) {
    return {
      mode: 'human_required', previousHead: decision.previousHead,
      reason: `PR history was rewritten (${verdict.reason}) and the whole current PR diff is too large to verify in one pass (${files} files, ${where}), and ${carried} blocking findings are still open (more than the ${MAX_CARRIED_FINDINGS} that can be carried safely); a finding cannot be dismissed until a review has covered the current HEAD, so a repository writer decides: comment "reset review" to discard the session and review the PR from scratch, or "override review" to accept the risk and waive the open findings`,
    };
  }
  return {
    ...fullReviewDecision(env, plan.requestedMode,
      `PR history was rewritten (${verdict.reason}) and the whole current PR diff (${files} files, ${where}) is too large for one verification; earlier open findings are carried as "needs confirmation", keep blocking until a person confirms them with a dismiss decision, and this review does not close them`),
    carryOpen: true,
  };
}

// The one decision for any review of the whole PR.
export function fullReviewDecision(env,requested,why){
  const diffBytes=fileBytes(path.join(path.resolve(env.REVIEW_CONTEXT_DIR||'.review-context'),'pr.diff'));
  return {mode:'full',previousHead:null,
    reason:`${why}: reviewing the ${Math.max(1,Math.round(diffBytes/1000))} KB diff in shards: ${providerPolicyFor(requested)==='claude_only'?'Claude only':'Gemini first, Claude continues if Gemini cannot'}`};
}

function fileBytes(file){
  try{return fs.statSync(file).size;}catch{return 0;}
}

function isPendingNewer(durable,pending){
  if(!durable)return true;
  if(durable.lastReviewedHead!==pending.lastReviewedHead)return true;
  const durableTime=Date.parse(durable.updatedAt??'');
  const pendingTime=Date.parse(pending.updatedAt??'');
  if(Number.isFinite(durableTime)&&Number.isFinite(pendingTime))return pendingTime>durableTime;
  return JSON.stringify(durable)!==JSON.stringify(pending);
}

function required(env,key){const v=env[key];if(!v)throw new Error(`Missing required environment variable: ${key}`);return String(v);}

function appendOutput(name,value,env){
  if(!env.GITHUB_OUTPUT)return;
  fs.appendFileSync(env.GITHUB_OUTPUT,`${name}=${String(value??'')}\n`);
}

const ORPHAN_RECONCILE_MODES = new Set(['verification', 'incremental', 'full', 'claude', 'human_required']);

// Reconcile bot-authored review threads missing from the current session.
// Only `auto` verification runs (or AUDIT_PENDING before final full review) adopt and verify orphans;
// all other runs report them without changing `decision.mode` or `session`. GraphQL errors degrade to no-op (I6).
export async function reconcileOrphanThreads({ plan, env = process.env, fetchImpl = fetch, log = console } = {}) {
  if (!plan?.session || !env.GH_TOKEN || plan.requestedMode === 'reset') return plan;
  if (!ORPHAN_RECONCILE_MODES.has(plan.decision?.mode)) return plan;

  const target = required(env, 'TARGET_REPO');
  const prNumber = Number(required(env, 'PR_NUMBER'));
  const headSha = required(env, 'HEAD_SHA');
  const botLogin = required(env, 'EXPECTED_REVIEW_AUTHOR').replace(/\[bot\]$/, '');
  const [owner, repo] = target.split('/');

  let threads;
  try {
    threads = await fetchReviewThreads({ owner, repo, number: prNumber, token: env.GH_TOKEN, fetchImpl });
  } catch (error) {
    log.warn?.(`Could not fetch review threads for orphan reconciliation; continuing without orphans: ${String(error.message).slice(0, 200)}`);
    return plan;
  }

  const found = findOrphanBotThreads({ session: plan.session, threads, botLogin });
  if (found.total === 0) return plan;

  const canAdopt = plan.requestedMode === 'auto'
    && (plan.decision.mode === 'verification' || (plan.session.status === 'AUDIT_PENDING' && isFullMode(plan.decision.mode)));

  if (!canAdopt) {
    return {
      ...plan,
      orphanReconcile: {
        found: found.total,
        adopted: 0,
        deferred: found.orphans.length,
        unrecognizable: found.unrecognizable,
        outsideDiff: 0,
        tooLarge: 0,
        reportOnly: true,
      },
    };
  }

  const contextDir = path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context');
  const { prDiff, chunks, capacity } = readCurrentPrScope({ contextDir, session: plan.session });
  if (capacity.kind === 'too_large') {
    return {
      ...plan,
      orphanReconcile: {
        found: found.total,
        adopted: 0,
        deferred: 0,
        unrecognizable: found.unrecognizable,
        outsideDiff: 0,
        tooLarge: found.orphans.length,
        reportOnly: false,
      },
    };
  }

  const diffPaths = new Set(chunks.map((c) => c.path));
  const adopted = adoptOrphanFindings({
    session: plan.session,
    orphans: found.orphans,
    diffPaths,
    headSha,
    maxAdopt: MAX_CARRIED_FINDINGS,
  });

  const orphanReconcile = {
    found: found.total,
    adopted: adopted.adoptedCount,
    deferred: adopted.deferredCount,
    unrecognizable: found.unrecognizable,
    outsideDiff: adopted.outsideDiffCount,
    tooLarge: 0,
    reportOnly: false,
  };

  if (adopted.adoptedCount === 0) {
    return { ...plan, orphanReconcile };
  }

  fs.mkdirSync(contextDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(contextDir, 'repair.diff'), prDiff, { mode: 0o600 });
  return {
    ...plan,
    session: adopted.session,
    decision: {
      mode: 'verification',
      previousHead: plan.decision.previousHead ?? plan.session.lastReviewedHead,
      scope: 'current-pr',
      reason: `reconciling ${adopted.adoptedCount} old bot thread(s) against the current PR diff (${plan.decision.reason})`,
    },
    orphanReconcile,
  };
}

export async function runSessionPlanner({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  let plan = await planSession({ env, fetchImpl });
  plan.decision = await resolveVerificationScope({ plan, env, fetchImpl });
  if (plan.decision.mode === 'incremental_candidate') {
    const previousHead = plan.decision.previousHead;
    const scope = prepareIncrementalDelta({
      repoDir: path.resolve(env.SOURCE_REPO_DIR || 'target'),
      contextDir: path.resolve(env.REVIEW_CONTEXT_DIR || '.review-context'),
      previousHead,
      headSha: required(env, 'HEAD_SHA'),
      session: plan.session,
      token: env.GH_TOKEN,
    });
    plan.decision = scope.mode === 'incremental'
      ? { mode: 'incremental', previousHead, reason: scope.reason }
      : fullReviewDecision(env, plan.requestedMode, scope.reason);
    log.log?.('Review scope: ' + scope.mode + ' — ' + scope.reason
      + (scope.changedLines == null ? '' : ' (' + scope.files + ' files, ' + scope.changedLines + ' lines)'));
  }
  // Orphan reconciliation may replace the decision, so scope and policy are stamped on the final plan.
  plan = await reconcileOrphanThreads({ plan, env, fetchImpl, log });
  return withScopeAndPolicy(plan);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const plan = await runSessionPlanner({ env: process.env });
    const output=path.resolve(process.env.REVIEW_CONTEXT_DIR||'.review-context','session-plan.json');
    fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
    fs.writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{mode:0o600});
    appendOutput('mode',plan.decision.mode,process.env);
    appendOutput('previous_head',plan.decision.previousHead||'',process.env);
    appendOutput('session_comment_id',plan.sessionCommentId||'',process.env);
    appendOutput('pending_source_comment_id',plan.pendingSourceCommentId||'',process.env);
    appendOutput('pending_review_id',plan.pendingReviewId||'',process.env);
    appendOutput('reason',plan.decision.reason.replace(/[\r\n]+/g,' '),process.env);
    console.log(`Review session plan: ${plan.decision.mode} — ${plan.decision.reason}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
