import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepReviewStale, parsePendingSessionReview, parseSessionComment, planReviewSession } from './review-session-core.mjs';
import { stagedDiffFits } from './review-shards.mjs';
import { blockingClaims, fetchReviewThreads, isWriter, threadsByFinding } from './review-threads.mjs';
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
  if(!['auto','claude','reset','override','dismiss','threads'].includes(requested)) throw new Error('Invalid REQUESTED_MODE');

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
        :requested==='threads'
          ?'recover published review session without another model call. Your review-thread decision was NOT applied yet; resolve the thread again (or comment @gemini review) after this recovery.'
          :'recover published review session without another model call'},
      session,
      sessionCommentId,
      pendingSession:pending.pending.session,
      pendingSourceCommentId:pending.pending.sourceCommentId,
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
    return {requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
  }

  // `@claude review` plans exactly like `@gemini review` (first review, incremental, verification or final
  // audit, whatever the session calls for); only the model differs: Claude alone instead of Gemini first.
  // A run still in progress for this exact HEAD is the one thing to wait for rather than start again.
  if(requested==='claude' && session && session.lastReviewedHead===headSha && session.status==='REVIEW_IN_PROGRESS' && !isDeepReviewStale(session)){
    const decision={mode:'noop_waiting',previousHead:headSha,reason:'a deep review is already in progress for this HEAD'};
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

  let decision=planReviewSession({session,baseSha,headSha,reset:requested==='reset',
    retryUnavailable:['auto','claude'].includes(requested) && env.SOURCE_KIND==='comment'});
  // One route for every full review, whatever its size or provider: the sharded engine (a small PR is
  // a single shard). It tries Gemini first and lets Claude continue what Gemini cannot finish. Delta
  // reviews (incremental, verification) and the final audit still use the staged Gemini pipeline.
  if(decision.mode==='discovery'){
    const diffBytes=fileBytes(path.join(path.resolve(env.REVIEW_CONTEXT_DIR||'.review-context'),'pr.diff'));
    decision={mode:'claude',previousHead:null,
      reason:`${decision.reason}: reviewing the ${Math.max(1,Math.round(diffBytes/1000))} KB diff in shards: ${requested==='claude'?'Claude only':'Gemini first, Claude continues if Gemini cannot'}`};
  }
  // A final audit has to see the whole PR in one staged run. When the diff is too big for that, the sharded engine
  // does the audit instead: it can continue over several runs, and a complete pass of it counts as the audit.
  if(decision.mode==='audit'){
    const contextRoot=path.resolve(env.REVIEW_CONTEXT_DIR||'.review-context');
    const diffFile=path.join(contextRoot,'pr.diff');
    if(fs.existsSync(diffFile) && !stagedDiffFits(fs.readFileSync(diffFile,'utf8'),readOptional(path.join(contextRoot,'ignore-patterns.txt')))){
      decision={mode:'claude',audit:true,previousHead:null,
        reason:`final audit of a large diff, in shards: ${requested==='claude'?'Claude only':'Gemini first, Claude continues if Gemini cannot'}; continues over several runs if needed`};
    }
  }
  return {requestedMode:requested,decision,session,sessionCommentId,pendingSession:null,pendingSourceCommentId:null,pendingReviewId:null};
}

function readOptional(file){
  try{return fs.readFileSync(file,'utf8');}catch{return '';}
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
