import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyExternalPremise,
  assessExternalPremise,
  applyExternalEvidence,
} from '../scripts/external-fact-evidence.mjs';

const SHA='a'.repeat(40);
const candidate = {
  severity:'P1',
  title:'Plot Style Guard references non-existent actions/checkout@v5',
  body:'The checkout step uses: actions/checkout@v5, but the official repository only has releases up to v4; CI cannot resolve this tag.',
  failurePath:'CI fails on workflow initialization.',
  riskClass:'Build / CI Failure',
  path:'.github/workflows/plot-style-guard.yml',
  line:15,
};
const modelConfirmed={candidateId:'D001',verdict:'CONFIRMED',reason:'Missing action tag',evidence:['Model claims official action only up to v4']};

test('the exact false positive is recognized as an external GitHub Action ref',()=>{
  assert.deepEqual(classifyExternalPremise(candidate), {kind:'github-action-ref',owner:'actions',repo:'checkout',ref:'v5'});
});

test('official existing tag falsifies a CONFIRMED Gemini finding',async()=>{
  const called=[];
  const assessed=await assessExternalPremise(candidate,{token:'secret',fetchImpl:async(url,opts)=>{
    called.push({url,opts});
    return Response.json({ref:'refs/tags/v5',object:{sha:SHA}});
  }});
  const checked=applyExternalEvidence(modelConfirmed,assessed);
  assert.equal(checked.verdict,'REJECTED');
  assert.match(checked.reason,/refs\/tags\/v5 exists/);
  assert.equal(called.length,1);
  assert.equal(called[0].url,'https://api.github.com/repos/actions/checkout/git/ref/tags/v5');
  assert.equal(called[0].opts.headers.Authorization,'Bearer secret');
  assert.doesNotMatch(JSON.stringify(checked),/secret/);
});

test('only missing tag and branch with verified public repo can support confirmation',async()=>{
  const urls=[];
  const assessed=await assessExternalPremise(candidate,{fetchImpl:async url=>{
    urls.push(url);
    return url.endsWith('/repos/actions/checkout') ? Response.json({full_name:'actions/checkout',private:false}) : new Response('',{status:404});
  }});
  assert.equal(assessed.disposition,'verified-absent');
  assert.equal(urls.length,3);
  const checked=applyExternalEvidence(modelConfirmed,assessed);
  assert.equal(checked.verdict,'CONFIRMED');
  assert.match(checked.reason,/both returned 404/);
  assert.equal(checked.evidence.length,4);
});

test('inaccessible repository or upstream outage cannot produce CONFIRMED',async()=>{
  for(const status of [403,429,500]){
    const assessed=await assessExternalPremise(candidate,{fetchImpl:async()=>new Response('',{status})});
    assert.equal(applyExternalEvidence(modelConfirmed,assessed).verdict,'UNCERTAIN');
  }
  const inaccessible=await assessExternalPremise(candidate,{fetchImpl:async()=>new Response('',{status:404})});
  assert.equal(applyExternalEvidence(modelConfirmed,inaccessible).verdict,'UNCERTAIN');
  const bad=await assessExternalPremise(candidate,{fetchImpl:async()=>Response.json({ref:'refs/tags/v5',object:{sha:'bad'}})});
  assert.equal(applyExternalEvidence(modelConfirmed,bad).verdict,'UNCERTAIN');
});

test('unsupported external API assertions retain the normal validator verdict',async()=>{
  const external={title:'Stripe API returns 404 for unsupported mode',body:'The Stripe API will reject this newly released mode.',path:'src/payments.js'};
  assert.deepEqual(classifyExternalPremise(external),{kind:'code-only'});
  const assessed=await assessExternalPremise(external,{fetchImpl:()=>{throw Error('The deterministic guard must not browse arbitrary URLs');}});
  assert.equal(assessed,null);
  assert.equal(applyExternalEvidence(modelConfirmed,assessed).verdict,'CONFIRMED');
});

test('purely local code bugs retain CONFIRMED status and never call the network',async()=>{
  const local={title:'Loss of synchronized evidence on writes',body:'This code loads stale snapshot, overwrites accepted state on disk.',path:'src/controller.js',riskClass:'state-invariant'};
  assert.deepEqual(classifyExternalPremise(local),{kind:'code-only'});
  const result=await assessExternalPremise(local,{fetchImpl:()=>{throw Error('Should not query GitHub');}});
  assert.equal(result,null);
  assert.equal(applyExternalEvidence(modelConfirmed,result).verdict,'CONFIRMED');
});

test('SHA-pinned action references cannot be treated as missing tag/branch',async()=>{
  const c={...candidate,title:'Non-existent actions/checkout@'+SHA,body:''};
  const assessed=await assessExternalPremise(c,{fetchImpl:()=>{throw Error('Must not probe a SHA as a tag');}});
  assert.equal(assessed.disposition,'uncertain');
});

test('F001: ordinary workflow issues mentioning an Action are still local findings',async()=>{
  const finding={
    path:'.github/workflows/ci.yml',
    title:'Workflow script injection in an untrusted step',
    body:'The workflow uses: actions/checkout@v4 and then executes attacker-controlled script input.',
  };
  assert.deepEqual(classifyExternalPremise(finding),{kind:'code-only'});
  const result=await assessExternalPremise(finding,{fetchImpl:()=>{throw Error('No external lookup for local defects');}});
  assert.equal(applyExternalEvidence(modelConfirmed,result).verdict,'CONFIRMED');
});

test('F002: missing permissions cannot be confused with an absent Action ref',async()=>{
  const finding={
    path:'.github/workflows/ci.yml',
    title:'Workflow step missing permissions',
    body:'The job uses actions/checkout@v4 but is missing contents: write permission.',
  };
  assert.deepEqual(classifyExternalPremise(finding),{kind:'code-only'});
  assert.equal(await assessExternalPremise(finding,{fetchImpl:()=>{throw Error('No external lookup');}}),null);
  assert.equal(applyExternalEvidence(modelConfirmed,null).verdict,'CONFIRMED');
  assert.deepEqual(classifyExternalPremise({
    ...finding,title:'actions/checkout@v4 is missing permissions',body:'',
  }),{kind:'code-only'});
});

test('F003: local provider and external names must not demote real code bugs',async()=>{
  for(const title of [
    'Auth provider fails to clear token on logout',
    'External vendor handler loses accepted persistence state',
    'ThemeProvider fails to restore a saved theme',
  ]){
    const finding={path:'src/auth/provider.ts',title,body:'The source file fails to update local state.'};
    assert.deepEqual(classifyExternalPremise(finding),{kind:'code-only'});
    assert.equal(await assessExternalPremise(finding,{fetchImpl:()=>{throw Error('No external lookup');}}),null);
  }
});

test('Action refs need a directly attached absence statement',()=>{
  const positive=[
    'Plot Style Guard references non-existent actions/checkout@v5',
    'Workflow uses non-existent `actions/checkout@v5`.',
    'The actions/checkout@v5 ref does not exist.',
    'Workflow requests missing Action version actions/checkout@v5',
  ];
  for(const title of positive){
    assert.deepEqual(classifyExternalPremise({path:'.github/workflows/ci.yml',title}),
      {kind:'github-action-ref',owner:'actions',repo:'checkout',ref:'v5'},title);
  }
  const unrelated={
    path:'.github/workflows/ci.yml',
    title:'Missing permissions',
    body:'The workflow invokes actions/checkout@v4.',
  };
  assert.deepEqual(classifyExternalPremise(unrelated),{kind:'code-only'});
});

test('only the specifically missing Action ref is probed when multiple Actions appear',()=>{
  const finding={path:'.github/workflows/ci.yml',
    title:'Workflow uses actions/checkout@v4 but also references non-existent actions/upload-artifact@v9'};
  assert.deepEqual(classifyExternalPremise(finding),
    {kind:'github-action-ref',owner:'actions',repo:'upload-artifact',ref:'v9'});
  assert.deepEqual(classifyExternalPremise({
    path:'.github/workflows/ci.yml',
    title:'Non-existent owner/repo/subdirectory@v9',
  }),{kind:'code-only'});
});
