import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepReviewStale, parsePendingSessionReview, parseSessionComment, planReviewSession } from './review-session-core.mjs';
import { prepareIncrementalDelta } from './select-incremental-review.mjs';

const repoPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern=/^[0-9a-f]{40}$/i;

export async function planSession({ env=process.env, fetchImpl=fetch }={}) {
  const target=required(env,'TARGET_REPO');
  if(!repoPattern.test(target)) throw new Error('Invalid TARGET_REPO');
  const pr=required(env,'PR_NUMBER');
  if(!/^[1-9]\d*$/.test(pr)) throw new Error('Invalid PR_NUMBER');
  const baseSha=required(env,'BASE_SHA');
  const headSha=required(env,'HEAD_SHA');
  if(!shaPattern.test(baseSha)||!shaPattern.test(headSha)) throw new Error('Invalid PR SHA');
  const requested=(env.REQUESTED_MODE||'auto').toLowerCase();
  if(!['auto','claude','reset','override','dismiss'].includes(requested)) throw new Error('Invalid REQUESTED_MODE');

  const expectedAuthor=required(env,'EXPECTED_REVIEW_AUTHOR');
  const comments=await loadComments(target,pr,env.GH_TOKEN,fetchImpl);
  const reviews=await loadReviews(target,pr,env.GH_TOKEN,fetchImpl);
  const candidates=comments
    .filter(c=>c?.user?.login===expectedAuthor && typeof c.body==='string' && c.body.includes('<!-- jiaze-review-session:v1 -->'))
    .sort((a,b)=>Number(b.id)-Number(a.id));

  let session=null;
  let sessionCommentId=null;
  if(candidates.length){
    sessionCommentId=String(candidates[0].id);
    session=parseSessionComment(candidates[0].body);
    if(!session) throw new Error('Latest bot-authored review session comment is unreadable; refusing to discard durable state');
  }

  const pendingCandidates=reviews
    .filter(r=>r?.user?.login===expectedAuthor && typeof r.body==='string')
    .map(r=>({reviewId:String(r.id),pending:parsePendingSessionReview(r.body)}))
    .filter(r=>r.pending && r.pending.session.lastReviewedHead===headSha)
    .sort((a,b)=>Number(b.reviewId)-Number(a.reviewId));
  const pending=pendingCandidates[0]??null;
  if(requested!=='reset' && pending && isPendingNewer(session,pending.pending.session)){
    return {
      requestedMode:requested,
      decision:{mode:'recover',previousHead:null,reason:requested==='claude'
        ?'recover published review session without another model call. Your @claude review request was NOT run; send it again after this recovery.'
        :'recover published review session without another model call'},
      session,
      sessionCommentId,
      pendingSession:pending.pending.session,
      pendingSourceCommentId:pending.pending.sourceCommentId,
      pendingReviewId:pending.reviewId,
    };
  }

  if(requested==='claude'){
    // Explicit deep review joins the durable session for this exact HEAD. A fresh
    // in-progress marker means a run is already going; a stale one is restartable.
    const waiting=session && session.lastReviewedHead===headSha && session.status==='REVIEW_IN_PROGRESS' && !isDeepReviewStale(session);
    const hasSession=session && session.lastReviewedHead===headSha;
    const decision=waiting
      ?{mode:'noop_waiting',previousHead:headSha,reason:'a Claude deep review is already in progress for this HEAD'}
      :!hasSession
        ?{mode:'noop_waiting',previousHead:null,reason:'Your @claude review request was NOT queued and no Claude review ran: there is no completed automatic review for this exact commit yet. This commit is not READY for deep review purposes. After the automatic review finishes (or after you comment @gemini review), send @claude review again.'}
        :{mode:'claude',previousHead:null,reason:'explicit Claude deep review bound to this HEAD'};
    return {requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  if(requested==='dismiss'){
    const eligible=session && ['REWORK','HUMAN_REQUIRED'].includes(session.status)
      && session.lastReviewedHead===headSha && session.findings.some(f=>['OPEN','UNCERTAIN'].includes(f.status));
    const decision=eligible
      ?{mode:'dismiss',previousHead:null,reason:'adjudicate one evidenced finding without bypassing final audit'}
      :{mode:'noop_waiting',previousHead:null,reason:'no OPEN or UNCERTAIN finding on the last-reviewed HEAD; review the current HEAD first'};
    return {requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  if(requested==='override'){
    const overridable=session&&['REWORK','HUMAN_REQUIRED','AUDIT_PENDING','PARTIAL'].includes(session.status);
    const decision=overridable
      ?{mode:'override',previousHead:null,reason:'manual override by a repository writer'}
      :{mode:'noop_waiting',previousHead:null,reason:'nothing to override: no unfinished review session for this PR'};
    return {requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  const decision=planReviewSession({session,baseSha,headSha,reset:requested==='reset',
    retryUnavailable:requested==='auto' && env.SOURCE_KIND==='comment'});
  return {requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
}

function isPendingNewer(durable,pending){
  if(!durable)return true;
  if(durable.lastReviewedHead!==pending.lastReviewedHead)return true;
  const durableTime=Date.parse(durable.updatedAt??'');
  const pendingTime=Date.parse(pending.updatedAt??'');
  if(Number.isFinite(durableTime)&&Number.isFinite(pendingTime))return pendingTime>durableTime;
  return JSON.stringify(durable)!==JSON.stringify(pending);
}

async function loadComments(repo,pr,token,fetchImpl){
  if(!token) throw new Error('Missing GH_TOKEN');
  const out=[];
  for(let page=1;page<=100;page+=1){
    const response=await fetchImpl(`https://api.github.com/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`,{
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'jiaze-review-bot'},
      signal:AbortSignal.timeout(15000),
    });
    if(!response.ok) throw new Error(`GitHub session lookup failed (HTTP ${response.status})`);
    const batch=await response.json();
    if(!Array.isArray(batch)) throw new Error('GitHub comments response was not an array');
    out.push(...batch);
    if(batch.length<100) return out;
  }
  throw new Error('Issue comment pagination exceeded safety limit');
}


async function loadReviews(repo,pr,token,fetchImpl){
  if(!token) throw new Error('Missing GH_TOKEN');
  const out=[];
  for(let page=1;page<=100;page+=1){
    const response=await fetchImpl(`https://api.github.com/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`,{
      headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'jiaze-review-bot'},
      signal:AbortSignal.timeout(15000),
    });
    if(!response.ok) throw new Error(`GitHub pending-review lookup failed (HTTP ${response.status})`);
    const batch=await response.json();
    if(!Array.isArray(batch)) throw new Error('GitHub reviews response was not an array');
    out.push(...batch);
    if(batch.length<100) return out;
  }
  throw new Error('Pull request review pagination exceeded safety limit');
}

function required(env,key){const v=env[key];if(!v)throw new Error(`Missing required environment variable: ${key}`);return String(v);}

function appendOutput(name,value,env){
  if(!env.GITHUB_OUTPUT)return;
  fs.appendFileSync(env.GITHUB_OUTPUT,`${name}=${String(value??'')}\n`);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const plan=await planSession();
    if (plan.decision.mode === 'incremental_candidate') {
      const previousHead = plan.decision.previousHead;
      const scope = prepareIncrementalDelta({
        repoDir: path.resolve(process.env.SOURCE_REPO_DIR || 'target'),
        contextDir: path.resolve(process.env.REVIEW_CONTEXT_DIR || '.review-context'),
        previousHead,
        headSha: required(process.env, 'HEAD_SHA'),
        session: plan.session,
        token: process.env.GH_TOKEN,
      });
      plan.decision = {
        mode: scope.mode,
        previousHead: scope.mode === 'incremental' ? previousHead : null,
        reason: scope.reason,
      };
      console.log('Review scope: ' + scope.mode + ' — ' + scope.reason
        + (scope.changedLines == null ? '' : ' (' + scope.files + ' files, ' + scope.changedLines + ' lines)'));
    }
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
