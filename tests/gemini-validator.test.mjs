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
