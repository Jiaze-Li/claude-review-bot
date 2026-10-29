import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiRequest,
  GEMINI_MODEL,
  GEMINI_TIMEOUT_DEFAULT_MS,
  GEMINI_TIMEOUT_MAX_MS,
  resolveGeminiTimeoutMs,
  runGeminiReview,
  toGeminiJsonSchema,
} from '../scripts/run-gemini-review.mjs';
import { applyDiscoveryResult } from '../scripts/review-session-core.mjs';
import { stateIntegrityProcedure } from '../scripts/review-prompts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const A='a'.repeat(40),BASE='b'.repeat(40);

const dirWith=(mode,diff='diff --git a/a b/a\n')=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-review-'));
  fs.writeFileSync(path.join(dir,'pr.json'),'{}');
  fs.writeFileSync(path.join(dir,'repair.diff'),diff);
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode},session:null}));
  return dir;
};
const clean=()=>Response.json({
  candidates:[{content:{parts:[{text:JSON.stringify({summary:'clean',findings:[]})}]}}],
  usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:10,totalTokenCount:130},
  modelVersion:'gemini-9.9-flash',
});

test('Gemini timeout is 180 seconds unless GEMINI_TIMEOUT_MS says otherwise, and is bounded',()=>{
  assert.equal(resolveGeminiTimeoutMs({env:{}}),GEMINI_TIMEOUT_DEFAULT_MS);
  assert.equal(resolveGeminiTimeoutMs({env:{GEMINI_TIMEOUT_MS:'300000'}}),300000);
  assert.equal(resolveGeminiTimeoutMs({env:{GEMINI_TIMEOUT_MS:'9999999'}}),GEMINI_TIMEOUT_MAX_MS);
  assert.equal(resolveGeminiTimeoutMs({env:{GEMINI_TIMEOUT_MS:'bad'}}),GEMINI_TIMEOUT_DEFAULT_MS);
});

test('the staged pipeline only reviews a repair or a small delta; a full review is never built here',()=>{
  for(const mode of ['discovery','audit']){
    assert.throws(()=>buildGeminiRequest({mode,repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'d',session:null}),/incremental or verification/);
  }
  const {prompt}=buildGeminiRequest({mode:'incremental',repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'delta',session:null});
  assert.match(prompt,/INCREMENTAL REVIEW/);
  assert.match(prompt,/not architecture redesign/i);
  assert.match(prompt,/P3 is non-blocking/);
});

test('the state-integrity procedure is shared text for every full review, and empty for an ordinary PR',()=>{
  const riskProfile={version:1,stateIntegrity:true,signals:{synchronization:['lock','git-ref-update'],durableState:['state','checkpoint-history'],multiActor:['worktree']}};
  const prompt=stateIntegrityProcedure(riskProfile);
  assert.match(prompt,/STATE-INTEGRITY RISK/);
  assert.match(prompt,/Trace BACKWARD from every write sink into its changed callers/);
  assert.match(prompt,/lock around the final write is NOT sufficient/i);
  assert.match(prompt,/snapshot is prepared before lock acquisition/);
  assert.match(prompt,/actor A reads snapshot S/);
  assert.match(prompt,/B can still succeed and silently overwrite A'/);
  assert.match(prompt,/Inspect changed callers and callees together across files/);
  assert.equal(stateIntegrityProcedure({version:1,stateIntegrity:false,signals:{}}),'');
  assert.equal(stateIntegrityProcedure(null),'');
});

test('verification covers stable open findings and new bugs introduced by the repair delta',()=>{
  const session=applyDiscoveryResult({result:{summary:'x',findings:[{
    severity:'P1',title:'Bug',body:'Trigger X causes Y, expected Z.',path:'a.js',line:1,riskClass:'state',
  }]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  const {prompt}=buildGeminiRequest({mode:'verification',repo:'a/b',prNumber:'1',headSha:A,prJson:'{}',diff:'repair',session});
  assert.match(prompt,/not a fresh PR-wide review/i);
  assert.match(prompt,/F001/);
  assert.match(prompt,/independent bugs introduced by this HEAD delta/i);
});

test('an incremental review sends medium thinking on the latest-Flash alias and a structured schema',async()=>{
  const dir=dirWith('incremental');
  let request;
  const logs=[];
  const result=await runGeminiReview({
    env:{GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir},
    logImpl:message=>logs.push(message),
    fetchImpl:async(url,init)=>{
      request={url,body:JSON.parse(init.body),headers:init.headers};
      return clean();
    },
  });
  assert.match(request.url,/models\/gemini-flash-latest:generateContent$/);
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel,'medium');
  assert.equal(request.body.generationConfig.responseFormat.text.mimeType,'APPLICATION_JSON');
  assert.ok(request.body.generationConfig.responseFormat.text.schema);
  assert.equal('maxLength' in request.body.generationConfig.responseFormat.text.schema.properties.summary,false);
  assert.equal(request.body.generationConfig.maxOutputTokens,16384);
  assert.equal(result._meta.effort,'medium');
  assert.equal(result._meta.requested_model,'gemini-flash-latest');
  assert.equal(result._meta.resolved_model,'gemini-9.9-flash');
  assert.equal(result._meta.usage.total_tokens,130);
  assert.equal(result._meta.timeout_ms,GEMINI_TIMEOUT_DEFAULT_MS);
  assert.equal(request.headers['x-goog-api-key'],'secret');
  assert.equal(logs.length,2);
  assert.match(logs[0],/mode=incremental.*timeout_ms=180000.*context_bytes=\d+.*request_bytes=\d+/);
  assert.match(logs[1],/mode=incremental.*elapsed_ms=\d+/);
  assert.doesNotMatch(logs.join('\n'),/secret/);
});

test('a verification review thinks at low effort',async()=>{
  const dir=dirWith('verification');
  const session=applyDiscoveryResult({result:{summary:'x',findings:[{severity:'P1',title:'Bug',body:'Trigger X causes Y, expected Z.',path:'a.js',line:1,riskClass:'state'}]},baseSha:BASE,headSha:A,sourceCommentId:'1'});
  fs.writeFileSync(path.join(dir,'session-plan.json'),JSON.stringify({decision:{mode:'verification'},session}));
  let request;
  const result=await runGeminiReview({
    env:{GEMINI_API_KEY:'k',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir},
    fetchImpl:async(url,init)=>{ request=JSON.parse(init.body); return Response.json({
      candidates:[{content:{parts:[{text:JSON.stringify({summary:'ok',verifications:[{id:'F001',verdict:'FIXED',reason:'guarded'}],findings:[]})}]}}],usageMetadata:{},
    }); },
  });
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel,'low');
  assert.equal(result._meta.effort,'low');
});

test('malformed structured output is retried once with the same request',async()=>{
  const dir=dirWith('incremental');
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
  assert.deepEqual(requests[1],requests[0]);
  assert.equal(result._meta.attempts,2);
  assert.deepEqual(result._meta.usage,{input_tokens:200,output_tokens:22,thoughts_tokens:45,total_tokens:267});
});

test('Gemini request timeout is not retried: Claude takes the review and the reason is recorded',async()=>{
  const dir=dirWith('incremental');
  const logs=[];
  let calls=0;
  const fetchImpl=async()=>{
    calls+=1;
    throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  };
  const baseEnv={GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'1',HEAD_SHA:A,REVIEW_CONTEXT_DIR:dir};
  // Without a Claude credential the review fails and says so.
  await assert.rejects(runGeminiReview({env:baseEnv,logImpl:message=>logs.push(message),fetchImpl}),/CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(calls,1);
  // With one, Claude takes over and the timeout is the recorded reason.
  const claudeCalls=[];
  const result=await runGeminiReview({
    env:{...baseEnv,CLAUDE_CODE_OAUTH_TOKEN:'t'},logImpl:message=>logs.push(message),fetchImpl,
    queryImpl:async function*(args){
      claudeCalls.push(args);
      yield {type:'system',subtype:'init',model:'claude-x'};
      yield {type:'result',subtype:'success',structured_output:{summary:'from claude',findings:[]},usage:{input_tokens:1,output_tokens:1}};
    },
  });
  assert.equal(calls,2);
  assert.equal(claudeCalls.length,1);
  assert.equal(result._meta.provider,'claude');
  assert.match(result._meta.fallback_reason,/timed out after/);
  assert.doesNotMatch(logs.join('\n'),/secret/);
});

test('review workflow does not pin GEMINI_MODEL, so the latest-Flash alias stays in effect',()=>{
  const yml=fs.readFileSync(new URL('../.github/workflows/review-v2.yml',import.meta.url),'utf8');
  assert.doesNotMatch(yml,/GEMINI_MODEL/);
  assert.equal(GEMINI_MODEL,'gemini-flash-latest');
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
