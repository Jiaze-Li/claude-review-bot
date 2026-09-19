import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePendingSessionReview, parseSessionComment, planReviewSession } from './review-session-core.mjs';

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
  if(!['auto','claude','reset'].includes(requested)) throw new Error('Invalid REQUESTED_MODE');

  if(requested==='claude'){
    return {requestedMode:requested,decision:{mode:'claude',previousHead:null,reason:'explicit legacy Claude review'},session:null,sessionCommentId:null};
  }

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
  if(pending && isPendingNewer(session,pending.pending.session)){
    return {
      requestedMode:requested,
      decision:{mode:'recover',previousHead:null,reason:'recover published review session without another model call'},
      session,
      sessionCommentId,
      pendingSession:pending.pending.session,
      pendingSourceCommentId:pending.pending.sourceCommentId,
      pendingReviewId:pending.reviewId,
    };
  }

  const decision=planReviewSession({session,baseSha,headSha,reset:requested==='reset'});
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
