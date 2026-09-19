import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverReviewSession } from '../scripts/recover-review-session.mjs';
import { applyDiscoveryResult } from '../scripts/review-session-core.mjs';

const HEAD='a'.repeat(40), BASE='b'.repeat(40);

test('recovery persists pending session with both original and retry source markers and no model call', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recover-review-'));
  const session=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:HEAD,sourceCommentId:'11'});
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({
    decision:{mode:'recover'},
    pendingSession:session,
    pendingSourceCommentId:'11',
    pendingReviewId:'101',
    sessionCommentId:null,
  }));
  const calls=[];
  const out=await recoverReviewSession({
    env:{GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',HEAD_SHA:HEAD,SOURCE_COMMENT_ID:'22',REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init={})=>{
      calls.push({url,method:init.method||'GET',body:init.body?JSON.parse(init.body):null});
      if(url.endsWith('/pulls/7')) return Response.json({head:{sha:HEAD}});
      if(url.endsWith('/issues/7/comments')) return Response.json({id:303});
      assert.fail('unexpected URL '+url);
    },
  });
  assert.equal(out.sessionCommentId,'303');
  const write=calls.find(c=>c.method==='POST');
  assert.match(write.body.body,/jiaze-review-source-comment:11/);
  assert.match(write.body.body,/jiaze-review-source-comment:22/);
  assert.match(write.body.body,/Status: \*\*READY\*\*/);
});

test('recovery fails closed if PR HEAD moved and writes no session', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recover-review-stale-'));
  const session=applyDiscoveryResult({result:{summary:'clean',findings:[]},baseSha:BASE,headSha:HEAD,sourceCommentId:'11'});
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({
    decision:{mode:'recover'},pendingSession:session,pendingSourceCommentId:'11',pendingReviewId:'101',sessionCommentId:null,
  }));
  const calls=[];
  await assert.rejects(()=>recoverReviewSession({
    env:{GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',HEAD_SHA:HEAD,SOURCE_COMMENT_ID:'22',REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init={})=>{calls.push({url,method:init.method||'GET'});return Response.json({head:{sha:'c'.repeat(40)}});},
  }),/HEAD moved/);
  assert.equal(calls.length,1);
});
