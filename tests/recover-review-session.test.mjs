import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverReviewSession } from '../scripts/recover-review-session.mjs';
import { applyDiscoveryResult } from '../scripts/review-session-core.mjs';
import { createFakePr, BOT } from './helpers/fake-pr.mjs';

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
  const pr=createFakePr();
  const out=await recoverReviewSession({
    env:{GH_TOKEN:'token',TARGET_REPO:'acme/project',PR_NUMBER:'7',HEAD_SHA:HEAD,SOURCE_COMMENT_ID:'22',REVIEW_CONTEXT_DIR:dir,EXPECTED_REVIEW_AUTHOR:BOT},
    fetchImpl:pr.layer(async(url)=>{
      if(url.endsWith('/pulls/7')) return Response.json({head:{sha:HEAD}});
      assert.fail('unexpected URL '+url);
    }),
  });
  // both the original and the retry command are receipted, the closing handoff carries the session, and the summary follows
  const all=pr.issue.map(c=>c.body).join('\n');
  assert.match(all,/Handled: comment 11 \(version created\)/);
  assert.match(all,/Handled: comment 22 \(version created\)/);
  assert.ok(pr.issue.some(c=>/Handoff: COMPLETE/.test(c.body)&&/session\.status: "AUDIT_PENDING"/.test(c.body)));
  assert.equal(out.sessionCommentId,pr.issue.at(-1).id);
  assert.match(pr.issue.at(-1).body,/Status: \*\*AUDIT_PENDING\*\*/);
  // the spend in the session came from an earlier run: say so instead of claiming this run was free
  assert.match(pr.issue.findLast(c=>/Handoff: COMPLETE/.test(c.body)).body,/^Spend: this run not recorded \(recovered from a review published by an earlier run\) \/ cumulative/m);
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
