import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VALIDATOR_THINKING,
  buildValidationContextForFinding,
  buildValidationPrompt,
  validateMaterialFindings,
} from '../scripts/validate-gemini-findings.mjs';

const HEAD='a'.repeat(40);

function tempRepo() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-validator-repo-'));
  fs.mkdirSync(path.join(root,'src'),{recursive:true});
  fs.mkdirSync(path.join(root,'tests'),{recursive:true});
  fs.writeFileSync(path.join(root,'src','controller.js'), [
    'async function reviewPr() {',
    '  bindEvidenceSubmissions({ loopState, submissions, evidenceFingerprint: delta.fingerprint });',
    '  if (finalHead !== observedHead) continue;',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root,'src','contractEvidence.js'), [
    'export function bindEvidenceSubmissions({ loopState, submissions, evidenceFingerprint }) {',
    '  loopState.evidenceRecords = submissions.map((item) => ({ ...item, evidenceFingerprint }));',
    '}',
    '',
    'export function evidenceStatusForScope({ loopState, evidenceFingerprint }) {',
    '  const records = loopState.evidenceRecords.filter((record) =>',
    '    record.evidenceFingerprint === evidenceFingerprint);',
    '  return { records, missing: records.length ? [] : [\"runtime\"] };',
    '}',
    '',
    'export function reviewerEvidenceBundle(args) {',
    '  return evidenceStatusForScope(args);',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root,'tests','evidence.test.js'), [
    'test(\"stale evidence cannot authorize new-code review\", async () => {',
    '  const oldRecord = { evidenceFingerprint: \"d1\" };',
    '  const current = evidenceStatusForScope({ loopState: { evidenceRecords: [oldRecord] }, evidenceFingerprint: \"d2\" });',
    '  assert.equal(current.records.length, 0);',
    '});',
  ].join('\n'));
  return root;
}

function contextDir(review) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-validator-context-'));
  fs.writeFileSync(path.join(dir,'review.json'),JSON.stringify(review));
  fs.writeFileSync(path.join(dir,'pr.diff'),[
    'diff --git a/src/controller.js b/src/controller.js',
    '--- a/src/controller.js',
    '+++ b/src/controller.js',
    '@@ -1 +1 @@',
    '+bindEvidenceSubmissions({ evidenceFingerprint: delta.fingerprint });',
  ].join('\n'));
  return dir;
}

const falsePositive={
  severity:'P1',
  title:'PR review silently rebinds caller evidence to a new HEAD',
  body:'In `reviewPr`, `bindEvidenceSubmissions` persists evidence in `loopState.evidenceRecords`; after `finalHead` changes the old records may be reused.',
  path:'src/controller.js',
  line:2,
  riskClass:'state-invariant',
};

test('targeted context follows candidate symbols to downstream fingerprint guards and tests',()=>{
  const root=tempRepo();
  const context=buildValidationContextForFinding({
    finding:falsePositive,
    repoRoot:root,
    prDiff:'diff --git a/src/controller.js b/src/controller.js\n+bindEvidenceSubmissions',
  });
  assert.match(context,/evidenceStatusForScope/);
  assert.match(context,/record\.evidenceFingerprint === evidenceFingerprint/);
  assert.match(context,/stale evidence cannot authorize new-code review/);
  assert.match(context,/bindEvidenceSubmissions/);
});

test('validator prompt requires falsification and forbids fresh discovery',()=>{
  const prompt=buildValidationPrompt({
    repo:'a/b',prNumber:'7',headSha:HEAD,
    contexts:[{candidateId:'D001',finding:falsePositive,context:'guard context'}],
  });
  assert.match(prompt,/Actively try to FALSIFY/);
  assert.match(prompt,/downstream guards/);
  assert.match(prompt,/Do not introduce new findings/);
  assert.match(prompt,/stale state is consumed merely because it remains stored/);
});

test('medium validator rejects a material false positive and keeps nonblocking P3',async()=>{
  const root=tempRepo();
  const dir=contextDir({
    summary:'discovery',
    findings:[
      falsePositive,
      {severity:'P3',title:'Minor',body:'Concrete minor issue.',path:'src/controller.js',line:3,riskClass:'minor'},
    ],
    _meta:{provider:'gemini',effort:'low',usage:{input_tokens:93000,output_tokens:400}},
  });
  let request;
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),
      REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    fetchImpl:async(url,init)=>{
      request={url,body:JSON.parse(init.body)};
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({
          summary:'Candidate is defeated by exact evidence fingerprint filtering.',
          validations:[{
            candidateId:'D001',
            verdict:'REJECTED',
            reason:'evidenceStatusForScope filters records to the current evidenceFingerprint before reviewerEvidenceBundle consumes them.',
            evidence:[
              'contractEvidence.js: record.evidenceFingerprint === evidenceFingerprint',
              'evidence.test.js: stale evidence cannot authorize new-code review',
            ],
          }],
        })}]}}],
        usageMetadata:{promptTokenCount:4200,candidatesTokenCount:120,thoughtsTokenCount:600,totalTokenCount:4920},
      });
    },
  });
  assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel,'medium');
  assert.equal(request.body.generationConfig.maxOutputTokens,8192);
  assert.equal(VALIDATOR_THINKING,'medium');
  assert.deepEqual(output.findings.map((f)=>f.severity),['P3']);
  assert.equal(output._validation.validations[0].verdict,'REJECTED');
  assert.equal(output._validation._meta.usage.input_tokens,4200);
  assert.match(fs.readFileSync(path.join(dir,'validated.json'),'utf8'),/REJECTED/);
});

test('validator retries one malformed structured response and then succeeds',async()=>{
  const root=tempRepo();
  const dir=contextDir({summary:'discovery',findings:[falsePositive]});
  let calls=0;
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),
      REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    fetchImpl:async()=>{
      calls+=1;
      if(calls===1){
        return Response.json({
          candidates:[{content:{parts:[{text:'{"summary":"broken","validations":['}]}}],
          usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:20,totalTokenCount:130},
        });
      }
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({
          summary:'Candidate is defeated by exact evidence fingerprint filtering.',
          validations:[{
            candidateId:'D001',verdict:'REJECTED',
            reason:'Current fingerprint filtering defeats the stale-record path.',
            evidence:['record.evidenceFingerprint === evidenceFingerprint'],
          }],
        })}]}}],
        usageMetadata:{promptTokenCount:110,candidatesTokenCount:12,thoughtsTokenCount:22,totalTokenCount:144},
      });
    },
  });
  assert.equal(calls,2);
  assert.equal(output.findings.length,0);
  assert.equal(output._validation.validations[0].verdict,'REJECTED');
  assert.equal(output._validation._meta.attempts,2);
  assert.equal(output._validation._meta.usage.input_tokens,210);
  assert.equal(output._validation._meta.usage.total_tokens,274);
});

test('confirmed material finding remains blocking after validation',async()=>{
  const root=tempRepo();
  const dir=contextDir({summary:'discovery',findings:[falsePositive]});
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),
      REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    fetchImpl:async()=>Response.json({
      candidates:[{content:{parts:[{text:JSON.stringify({
        summary:'Failure survives guards.',
        validations:[{
          candidateId:'D001',verdict:'CONFIRMED',
          reason:'The sink consumes the stale record without checking its fingerprint.',
          evidence:['consumer.js lacks a fingerprint check'],
        }],
      })}]}}],
      usageMetadata:{promptTokenCount:1000,candidatesTokenCount:100,totalTokenCount:1100},
    }),
  });
  assert.equal(output.findings.length,1);
  assert.equal(output.findings[0].severity,'P1');
  assert.equal(output._validation.validations[0].verdict,'CONFIRMED');
});

test('omitted validator verdict becomes nonblocking UNCERTAIN rather than an invented confirmation',async()=>{
  const root=tempRepo();
  const dir=contextDir({summary:'discovery',findings:[falsePositive]});
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),
      REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    fetchImpl:async()=>Response.json({
      candidates:[{content:{parts:[{text:JSON.stringify({summary:'No verdict returned.',validations:[]})}]}}],
      usageMetadata:{},
    }),
  });
  assert.equal(output.findings.length,0);
  assert.equal(output._validation.validations[0].verdict,'UNCERTAIN');
});

test('no material findings skip the validator API entirely',async()=>{
  const root=tempRepo();
  const dir=contextDir({
    summary:'clean enough',
    findings:[{severity:'P3',title:'Minor',body:'Concrete.',path:'src/controller.js',line:1,riskClass:'minor'}],
  });
  let calls=0;
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),
      REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    fetchImpl:async()=>{calls+=1;throw new Error('should not call API');},
  });
  assert.equal(calls,0);
  assert.equal(output._validation.status,'SKIPPED');
  assert.equal(output.findings.length,1);
});


test('state-integrity material validator gets larger structured-output budget',async()=>{
  const root=tempRepo();
  const dir=contextDir({
    summary:'risk audit',
    findings:[falsePositive],
    _meta:{
      provider:'gemini',
      effort:'medium',
      mode:'audit',
      risk_profile:{
        version:1,
        stateIntegrity:true,
        signals:{synchronization:['lock'],durableState:['state'],multiActor:['worktree']},
      },
    },
  });
  let request;
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),
      REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    fetchImpl:async(url,init)=>{
      request=JSON.parse(init.body);
      return Response.json({
        candidates:[{content:{parts:[{text:JSON.stringify({
          summary:'Failure survives guards.',
          validations:[{
            candidateId:'D001',verdict:'CONFIRMED',
            reason:'The stale snapshot can reach the sink.',
            evidence:['caller reads before the lock-protected sink'],
          }],
        })}]}}],
        usageMetadata:{promptTokenCount:1000,candidatesTokenCount:100,thoughtsTokenCount:500,totalTokenCount:1600},
      });
    },
  });
  assert.equal(request.generationConfig.thinkingConfig.thinkingLevel,'medium');
  assert.equal(request.generationConfig.maxOutputTokens,32768);
  assert.equal(output._validation._meta.max_output_tokens,32768);
  assert.equal(output._validation._meta.risk_profile.stateIntegrity,true);
  assert.equal(output._validation.validations[0].verdict,'CONFIRMED');
});

test('CONFIRMED verdict without cited evidence is downgraded to UNCERTAIN', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { validateMaterialFindings } = await import('../scripts/validate-gemini-findings.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'val-ev-'));
  const repo = path.join(root, 'repo'); const ctx = path.join(root, 'ctx');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(ctx);
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(ctx, 'pr.diff'), '');
  const input = path.join(ctx, 'review.json');
  fs.writeFileSync(input, JSON.stringify({ summary: 's', findings: [
    { severity: 'P1', title: 'Bug', body: 'b', path: 'src/a.js', line: 1, riskClass: 'x' },
  ] }));
  const out = await validateMaterialFindings({
    env: { GEMINI_API_KEY: 'k', TARGET_REPO: 'a/b', PR_NUMBER: '1', HEAD_SHA: 'a'.repeat(40),
      TARGET_REPO_DIR: repo, REVIEW_CONTEXT_DIR: ctx, REVIEW_INPUT_PATH: input, REVIEW_OUTPUT_PATH: path.join(ctx, 'out.json') },
    fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      summary: 'v', validations: [{ candidateId: 'D001', verdict: 'CONFIRMED', reason: 'looks real', evidence: [] }],
    }) }] } }] }),
  });
  assert.equal(out._validation.validations[0].verdict, 'UNCERTAIN');
  assert.equal(out.findings.length, 0);
  assert.equal(out._validation.validations[0].path, 'src/a.js');
});

test('official action tag defeats a Gemini CONFIRMED finding in the complete validator',async()=>{
  const root=tempRepo();
  const wf=path.join(root,'.github','workflows');
  fs.mkdirSync(wf,{recursive:true});
  fs.writeFileSync(path.join(wf,'plot-style-guard.yml'),'steps:\n  - uses: actions/checkout@v5\n');
  const finding={
    severity:'P1',
    title:'Plot Style Guard references non-existent actions/checkout@v5',
    body:'The workflow uses: actions/checkout@v5, which is not released; official action only supports v4.',
    path:'.github/workflows/plot-style-guard.yml',
    line:2,
    riskClass:'Build / CI Failure',
  };
  const dir=contextDir({summary:'discovery',findings:[finding]});
  const githubCalls=[];
  let inspectedPrompt='';
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'gemini-secret',GH_TOKEN:'github-secret',TARGET_REPO:'a/b',
      PR_NUMBER:'7',HEAD_SHA:HEAD,TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    githubFetchImpl:async(url,init)=>{
      githubCalls.push({url,init});
      return Response.json({ref:'refs/tags/v5',object:{sha:HEAD}});
    },
    fetchImpl:async(_url,init)=>{
      inspectedPrompt=JSON.parse(init.body).contents[0].parts[0].text;
      return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({
        summary:'Another model mistakenly accepted the candidate.',
        validations:[{
          candidateId:'D001',verdict:'CONFIRMED',
          reason:'The action only has releases up to v4.',
          evidence:['The claimed v5 ref does not exist'],
        }],
      })}]}}]});
    },
  });
  assert.equal(output.findings.length,0);
  assert.equal(output._validation.validations[0].verdict,'REJECTED');
  assert.match(output._validation.validations[0].reason,/refs\/tags\/v5 exists/);
  assert.match(inspectedPrompt,/AUTHORITATIVE EXTERNAL FACT CHECK/);
  assert.equal(githubCalls.length,1);
  assert.equal(githubCalls[0].url,'https://api.github.com/repos/actions/checkout/git/ref/tags/v5');
  assert.equal(githubCalls[0].init.headers.Authorization,'Bearer github-secret');
  assert.doesNotMatch(inspectedPrompt,/github-secret|gemini-secret/);
  assert.doesNotMatch(JSON.stringify(output),/github-secret|gemini-secret/);
});

test('external Action ref cannot block when authoritative GitHub lookup is unavailable',async()=>{
  const root=tempRepo();
  const finding={
    severity:'P1',
    title:'Non-existent actions/checkout@v5 breaks CI',
    body:'GitHub Actions cannot resolve uses: actions/checkout@v5.',
    path:'.github/workflows/plot-style-guard.yml',
    line:1,
    riskClass:'Build / CI Failure',
  };
  const dir=contextDir({summary:'discovery',findings:[finding]});
  const output=await validateMaterialFindings({
    env:{
      GEMINI_API_KEY:'secret',TARGET_REPO:'a/b',PR_NUMBER:'7',HEAD_SHA:HEAD,
      TARGET_REPO_DIR:root,REVIEW_CONTEXT_DIR:dir,
      REVIEW_INPUT_PATH:path.join(dir,'review.json'),REVIEW_OUTPUT_PATH:path.join(dir,'validated.json'),
    },
    githubFetchImpl:async()=>new Response('',{status:403}),
    fetchImpl:async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify({
      summary:'Claims official version is missing.',
      validations:[{candidateId:'D001',verdict:'CONFIRMED',reason:'No v5',evidence:['Assertion only']}],
    })}]}}]}),
  });
  assert.equal(output.findings.length,0);
  assert.equal(output._validation.validations[0].verdict,'UNCERTAIN');
  assert.match(output._validation.validations[0].reason,/Could not verify/);
});
