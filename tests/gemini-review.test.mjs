import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiRequest, runGeminiReview, toGeminiJsonSchema } from '../scripts/run-gemini-review.mjs';
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

test('final audit is a second independent material-only broad pass',()=>{
  const {prompt,schema}=buildGeminiRequest({mode:'audit',repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'final diff',session:null});
  assert.match(prompt,/ONE final independent broad audit/);
  assert.match(prompt,/P0\/P1\/P2/);
  assert.match(prompt,/Do not report P3/);
  assert.equal(schema.properties.findings.maxItems,4);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum,['P0','P1','P2']);
});

test('state-integrity final audit requires explicit interleaving reasoning',()=>{
  const riskProfile={
    version:1,
    stateIntegrity:true,
    signals:{
      synchronization:['lock','git-ref-update'],
      durableState:['state','checkpoint-history'],
      multiActor:['worktree'],
    },
  };
  const {prompt}=buildGeminiRequest({
    mode:'audit',repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'final diff',session:null,riskProfile,
  });
  assert.match(prompt,/STATE-INTEGRITY RISK/);
  assert.match(prompt,/two-actor\/process\/worktree interleaving/);
  assert.match(prompt,/read -> validate -> modify -> write/);
  assert.match(prompt,/stale snapshots, lost updates, TOCTOU/);
  assert.match(prompt,/do not infer safety merely because a lock exists/i);
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
  assert.equal(request.body.generationConfig.responseFormat.text.mimeType,'APPLICATION_JSON');
  assert.ok(request.body.generationConfig.responseFormat.text.schema);
  assert.equal('maxLength' in request.body.generationConfig.responseFormat.text.schema.properties.summary,false);
  assert.equal(request.body.generationConfig.maxOutputTokens,16384);
  assert.equal(result._meta.effort,'low');
  assert.equal(result._meta.usage.total_tokens,130);
  assert.equal(request.headers['x-goog-api-key'],'secret');
});


test('Gemini JSON-schema adapter strips unsupported length keywords but preserves object constraints',()=>{
  const out=toGeminiJsonSchema({
    type:'object',additionalProperties:false,maxLength:99,
    properties:{
      name:{type:'string',maxLength:20},
      line:{type:['integer','null'],minimum:1},
    },
    required:['name','line'],
  });
  assert.deepEqual(out,{
    type:'object',additionalProperties:false,
    properties:{
      name:{type:'string'},
      line:{type:['integer','null'],minimum:1},
    },
    required:['name','line'],
  });
});


test('state-integrity final audit escalates to medium thinking',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-risk-audit-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'pr.diff'),'diff --git a/a b/a\n+state lock worktree checkpoint\n');
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'audit'},session:{}}));
  fs.writeFileSync(path.join(dir,'risk-profile.json'),JSON.stringify({
    version:1,
    stateIntegrity:true,
    signals:{
      synchronization:['lock'],
      durableState:['state','checkpoint-history'],
      multiActor:['worktree'],
    },
  }));

  let request;
  const result=await runGeminiReview({
    env:{GEMINI_API_KEY:'dummy-key',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init)=>{
      request={url,body:JSON.parse(init.body)};
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({summary:'clean',findings:[]})}]}}],
        usageMetadata:{promptTokenCount:120,candidatesTokenCount:20,thoughtsTokenCount:30,totalTokenCount:170},
      });
    },
  });

  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel,'medium');
  assert.match(request.body.contents[0].parts[0].text,/STATE-INTEGRITY RISK/);
  assert.equal(result._meta.effort,'medium');
  assert.equal(result._meta.risk_profile.stateIntegrity,true);
});

test('normal final audit remains low thinking',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-normal-audit-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'pr.diff'),'diff --git a/a b/a\n+renderPanel();\n');
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'audit'},session:{}}));
  fs.writeFileSync(path.join(dir,'risk-profile.json'),JSON.stringify({
    version:1,
    stateIntegrity:false,
    signals:{synchronization:[],durableState:[],multiActor:[]},
  }));

  let request;
  const result=await runGeminiReview({
    env:{GEMINI_API_KEY:'dummy-key',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init)=>{
      request={body:JSON.parse(init.body)};
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({summary:'clean',findings:[]})}]}}],
        usageMetadata:{},
      });
    },
  });

  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel,'low');
  assert.doesNotMatch(request.body.contents[0].parts[0].text,/STATE-INTEGRITY RISK/);
  assert.equal(result._meta.effort,'low');
});


test('risk final audit retries malformed structured output once with the same medium request',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-risk-retry-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'pr.diff'),'diff --git a/a b/a\n+state lock worktree checkpoint\n');
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'audit'},session:{}}));
  fs.writeFileSync(path.join(dir,'risk-profile.json'),JSON.stringify({
    version:1,
    stateIntegrity:true,
    signals:{
      synchronization:['lock'],
      durableState:['state','checkpoint-history'],
      multiActor:['worktree'],
    },
  }));

  const requests=[];
  let call=0;
  const result=await runGeminiReview({
    env:{GEMINI_API_KEY:'dummy-key',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init)=>{
      requests.push(JSON.parse(init.body));
      call+=1;
      if(call===1){
        return Response.json({
          candidates:[{content:{parts:[{text:'{"summary":"truncated","findings":['}]}}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:12,thoughtsTokenCount:20,totalTokenCount:132},
        });
      }
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({summary:'clean',findings:[]})}]}}],
        usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:25,totalTokenCount:135},
      });
    },
  });

  assert.equal(call,2);
  assert.equal(requests[0].generationConfig.thinkingConfig.thinkingLevel,'medium');
  assert.equal(requests[1].generationConfig.thinkingConfig.thinkingLevel,'medium');
  assert.deepEqual(requests[1],requests[0]);
  assert.equal(result._meta.attempts,2);
  assert.equal(result._meta.effort,'medium');
  assert.deepEqual(result._meta.usage,{
    input_tokens:200,
    output_tokens:22,
    thoughts_tokens:45,
    total_tokens:267,
  });
});
