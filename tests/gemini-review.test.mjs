import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiRequest, runGeminiReview } from '../scripts/run-gemini-review.mjs';
import { applyDiscoveryResult } from '../scripts/review-session-core.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const A='a'.repeat(40),BASE='b'.repeat(40);

test('discovery prompt permits one broad pass but rejects architecture/style work',()=>{
  const {prompt}=buildGeminiRequest({mode:'discovery',repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'diff',session:null});
  assert.match(prompt,/ONE broad discovery pass/);
  assert.match(prompt,/not architecture redesign/i);
  assert.match(prompt,/P3 is non-blocking/);
});

test('verification prompt is restricted to stable open findings and repair-induced regressions',()=>{
  const session=applyDiscoveryResult({result:{summary:'x',findings:[{
    severity:'P1',title:'Bug',body:'Trigger X causes Y, expected Z.',path:'a.js',line:1,riskClass:'state',
  }]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const {prompt}=buildGeminiRequest({mode:'verification',repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'repair',session});
  assert.match(prompt,/not a fresh PR-wide review/i);
  assert.match(prompt,/F001/);
  assert.match(prompt,/directly caused by this repair/i);
});

test('Gemini runner sends low thinking and structured schema',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-review-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'pr.diff'),'diff --git a/a b/a\n');
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'discovery'},session:null}));
  let request;
  const result=await runGeminiReview({
    env:{GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init)=>{
      request={url,body:JSON.parse(init.body),headers:init.headers};
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({summary:'clean',findings:[]})}]}}],
        usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130},
      });
    },
  });
  assert.match(request.url,/gemini-3\.8-flash:generateContent$/);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel,'low');
  assert.equal(request.body.generationConfig.responseMimeType,'application/json');
  assert.equal(request.body.generationConfig.maxOutputTokens,16384);
  assert.equal(result._meta.effort,'low');
  assert.equal(result._meta.usage.total_tokens,130);
  assert.equal(request.headers['x-goog-api-key'],'secret');
});
