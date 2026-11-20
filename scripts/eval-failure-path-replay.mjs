#!/usr/bin/env node
// L4 real-model replay harness for AC4 (not run in CI).
// Compares baseline (failureRecovery=false) vs improved (failureRecovery=true) prompts
// over sanitized PR #60 vectors while enforcing a hard $5.00 cumulative spend cap.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectReviewRisk } from './detect-review-risk.mjs';
import { runReview } from './run-review.mjs';

const MAX_TOTAL_SPEND_USD = 5.0;

const VECTORS = [
  {
    id: 'V1',
    name: 'PR #60 boolean MCP query + rollback (6374db2)',
    expectDefect: true,
    match: (f) => /unknown|absent|hasClaudeMcp|hasCodexMcp|boolean|fail.*absent|query.*fail|error.*treat/i.test(`${f.title} ${f.body} ${f.failurePath}`),
    files: ['bin/install-plugin.js'],
    diff: [
      'diff --git a/bin/install-plugin.js b/bin/install-plugin.js',
      '--- a/bin/install-plugin.js',
      '+++ b/bin/install-plugin.js',
      '@@ -158,6 +158,28 @@',
      '+function runCli(execFileSync, cmd, args, { allowFailure = false } = {}) {',
      '+  try {',
      '+    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });',
      '+  } catch (err) {',
      '+    if (allowFailure) return null;',
      '+    throw err;',
      '+  }',
      '+}',
      '+function hasClaudeMcp(execFileSync, name = "reviewloop") {',
      '+  return runCli(execFileSync, "claude", ["mcp", "get", name], { allowFailure: true }) !== null;',
      '+}',
      '+// Rollback any newly added MCP registration when install fails.',
      '+function reconcileMcp({ execFileSync, mcpBefore }) {',
      '+  const after = hasClaudeMcp(execFileSync);',
      '+  if (!mcpBefore.claude && after) {',
      '+    runCli(execFileSync, "claude", ["mcp", "remove", "reviewloop", "--scope", "user"], { allowFailure: true });',
      '+  }',
      '+}',
    ].join('\n'),
  },
  {
    id: 'V2',
    name: 'PR #60 tri-state MCP query + rollback (35279dd, fixed)',
    expectDefect: false,
    match: (f) => /treat(?:s|ed|ing)?\s+(?:fail|error).*absent|boolean.*mcp|missing\s+tri-state/i.test(`${f.title} ${f.body} ${f.failurePath}`),
    files: ['bin/install-plugin.js'],
    diff: [
      'diff --git a/bin/install-plugin.js b/bin/install-plugin.js',
      '--- a/bin/install-plugin.js',
      '+++ b/bin/install-plugin.js',
      '@@ -158,6 +158,26 @@',
      '+const NOT_REGISTERED_RE = /not\\s+found|no\\s+mcp\\s+server|not\\s+configured|does\\s+not\\s+exist/i;',
      '+function mcpState(execFileSync, command, name) {',
      '+  try {',
      '+    execFileSync(command, ["mcp", "get", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });',
      '+    return "present";',
      '+  } catch (err) {',
      '+    const text = `${err?.stderr ?? ""} ${err?.stdout ?? ""} ${err?.message ?? ""}`;',
      '+    return NOT_REGISTERED_RE.test(text) ? "absent" : "unknown";',
      '+  }',
      '+}',
      '+// Rollback only removes when before==="absent" and after==="present"; unknown is never removed.',
      '+function reconcileMcp({ execFileSync, mcpBefore }) {',
      '+  const after = mcpState(execFileSync, "claude", "reviewloop");',
      '+  if (mcpBefore.claude === "absent" && after === "present") {',
      '+    execFileSync("claude", ["mcp", "remove", "reviewloop", "--scope", "user"]);',
      '+  }',
      '+}',
    ].join('\n'),
  },
  {
    id: 'V3',
    name: 'PR #60 chmod sibling pair (one guarded, cliLink unguarded)',
    expectDefect: true,
    match: (f) => /root|getuid|chmod|0o555|permission/i.test(`${f.title} ${f.body} ${f.failurePath}`),
    files: ['tests/installRollbackSafety.test.js', 'tests/cliLink.test.js'],
    diff: [
      'diff --git a/tests/installRollbackSafety.test.js b/tests/installRollbackSafety.test.js',
      '--- a/tests/installRollbackSafety.test.js',
      '+++ b/tests/installRollbackSafety.test.js',
      '@@ -1,4 +1,11 @@',
      '+const isRoot = typeof process.getuid === "function" && process.getuid() === 0;',
      '+const SKIP_ROOT = isRoot ? "permission-bit fault injection does not apply to root" : false;',
      '+test("rollback when target is read-only", { skip: SKIP_ROOT }, async () => {',
      '+  await chmod(agents, 0o444);',
      '+  await assert.rejects(() => installGlobal());',
      '+});',
      'diff --git a/tests/cliLink.test.js b/tests/cliLink.test.js',
      '--- a/tests/cliLink.test.js',
      '+++ b/tests/cliLink.test.js',
      '@@ -138,6 +138,12 @@',
      '+test("permission denied: reports, leaves the old link", async () => {',
      '+  const parent = path.dirname(libPkg);',
      '+  try {',
      '+    await chmod(parent, 0o555);',
      '+    const results = applyCliRepair(planCliRepair(inspect(prefix)));',
      '+    assert.equal(results[0].applied, false);',
      '+  } finally { await chmod(parent, 0o755).catch(() => {}); }',
      '+});',
    ].join('\n'),
  },
  {
    id: 'V4',
    name: 'Chmod sibling pair both guarded with isRoot (fixed)',
    expectDefect: false,
    match: (f) => /(?:lack|missing|without|no)\s+(?:a\s+)?(?:root|getuid|SKIP_ROOT)/i.test(`${f.title} ${f.body} ${f.failurePath}`),
    files: ['tests/installRollbackSafety.test.js', 'tests/cliLink.test.js'],
    diff: [
      'diff --git a/tests/installRollbackSafety.test.js b/tests/installRollbackSafety.test.js',
      '--- a/tests/installRollbackSafety.test.js',
      '+++ b/tests/installRollbackSafety.test.js',
      '@@ -1,4 +1,13 @@',
      '+const isRoot = typeof process.getuid === "function" && process.getuid() === 0;',
      '+const SKIP_ROOT = isRoot ? "permission-bit fault injection does not apply to root" : false;',
      '+test("rollback when target is read-only", { skip: SKIP_ROOT }, async () => {',
      '+  try {',
      '+    await chmod(agents, 0o444);',
      '+    await assert.rejects(() => installGlobal());',
      '+  } finally { await chmod(agents, 0o644).catch(() => {}); }',
      '+});',
      'diff --git a/tests/cliLink.test.js b/tests/cliLink.test.js',
      '--- a/tests/cliLink.test.js',
      '+++ b/tests/cliLink.test.js',
      '@@ -138,6 +138,14 @@',
      '+const isRoot = typeof process.getuid === "function" && process.getuid() === 0;',
      '+const SKIP_ROOT = isRoot ? "permission-bit fault injection does not apply to root" : false;',
      '+test("permission denied: reports, leaves the old link", { skip: SKIP_ROOT }, async () => {',
      '+  const parent = path.dirname(libPkg);',
      '+  try {',
      '+    await chmod(parent, 0o555);',
      '+    const results = applyCliRepair(planCliRepair(inspect(prefix)));',
      '+    assert.equal(results[0].applied, false);',
      '+  } finally { await chmod(parent, 0o755).catch(() => {}); }',
      '+});',
    ].join('\n'),
  },
];

async function runSingleVector(vector, enableFailureRecovery, runIndex) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `l4-${vector.id}-${enableFailureRecovery ? 'new' : 'base'}-`));
  const ctxDir = path.join(tmpDir, '.review-context');
  const safeDir = path.join(tmpDir, 'safe-target');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.mkdirSync(safeDir, { recursive: true });

  const risk = detectReviewRisk({ diff: vector.diff });
  risk.failureRecovery = enableFailureRecovery;
  if (!enableFailureRecovery) {
    risk.signals.recovery = [];
    risk.signals.externalCall = [];
    risk.signals.faultInjection = [];
  }

  fs.writeFileSync(path.join(ctxDir, 'pr.diff'), `${vector.diff}\n`);
  fs.writeFileSync(path.join(ctxDir, 'changed-files.txt'), `${vector.files.join('\n')}\n`);
  fs.writeFileSync(path.join(ctxDir, 'diff-stat.txt'), `${vector.files.join(', ')}\n`);
  fs.writeFileSync(path.join(ctxDir, 'pr.json'), JSON.stringify({ number: 60, title: vector.name, base: { ref: 'main' } }));
  fs.writeFileSync(path.join(ctxDir, 'skipped-files.txt'), '');
  fs.writeFileSync(path.join(ctxDir, 'ignore-patterns.txt'), '');
  fs.writeFileSync(path.join(ctxDir, 'risk-profile.json'), JSON.stringify(risk, null, 2));
  fs.writeFileSync(path.join(ctxDir, 'session-plan.json'), JSON.stringify({ session: null }));

  // Populate safe-target/ with the vector's file contents so Read/Grep tools see real code.
  for (const chunk of vector.diff.split(/^diff --git /m).filter(Boolean)) {
    const m = chunk.match(/^a\/(\S+) b\/\S+/);
    if (!m) continue;
    const rel = m[1];
    const body = chunk.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    const targetPath = path.join(safeDir, rel);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${body}\n`);
  }

  try {
    const doc = await runReview({
      cwd: tmpDir,
      env: {
        ...process.env,
        REVIEW_PROVIDERS: 'claude',
        SAFE_REPO_DIR: safeDir,
        REVIEW_CONTEXT_DIR: ctxDir,
        REVIEW_OUTPUT_PATH: path.join(ctxDir, 'review.json'),
        TARGET_REPO: 'Jiaze-Li/reviewloop',
        PR_NUMBER: '60',
        HEAD_SHA: String(runIndex).padStart(40, '0'),
        DEEP_REVIEW_SHARD_TURNS: '10',
        DEEP_REVIEW_MAX_BUDGET_USD: '0.50',
      },
    });
    const matched = (doc.findings ?? []).some((f) => vector.match(f));
    return {
      ok: true,
      matched,
      findingsCount: (doc.findings ?? []).length,
      findingTitles: (doc.findings ?? []).map((f) => `[${f.severity}] ${f.title}`),
      costUsd: doc._meta?.total_cost_usd ?? 0,
      turns: doc._meta?.num_turns ?? 0,
      model: doc._meta?.resolved_model ?? doc._meta?.requested_model ?? 'claude',
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runReplay({ runsPerVariant = 2 } = {}) {
  let totalSpend = 0;
  const rows = [];
  for (const vector of VECTORS) {
    for (const variant of [false, true]) {
      for (let i = 1; i <= runsPerVariant; i += 1) {
        if (totalSpend >= MAX_TOTAL_SPEND_USD) {
          throw new Error(`Aborted L4 replay: cumulative spend $${totalSpend.toFixed(4)} reached cap $${MAX_TOTAL_SPEND_USD.toFixed(2)}`);
        }
        const res = await runSingleVector(vector, variant, i);
        totalSpend += res.costUsd;
        rows.push({ vector: vector.id, expectDefect: vector.expectDefect, improved: variant, run: i, ...res });
        console.error(`[L4] ${vector.id} (${variant ? 'improved' : 'baseline'}) #${i}: matched=${res.matched} findings=${res.findingsCount} cost=$${res.costUsd.toFixed(4)} total=$${totalSpend.toFixed(4)}`);
      }
    }
  }
  const summarize = (improved) => {
    const subset = rows.filter((r) => r.improved === improved);
    const pos = subset.filter((r) => r.expectDefect);
    const neg = subset.filter((r) => !r.expectDefect);
    return {
      runs: subset.length,
      spendUsd: Number(subset.reduce((s, r) => s + r.costUsd, 0).toFixed(4)),
      recall: `${pos.filter((r) => r.matched).length}/${pos.length}`,
      falsePositives: `${neg.filter((r) => r.matched).length}/${neg.length}`,
    };
  };
  return {
    model: rows.find((r) => r.model)?.model ?? 'claude',
    runsPerVariant,
    totalSpendUsd: Number(totalSpend.toFixed(4)),
    baseline: summarize(false),
    improved: summarize(true),
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runsArg = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 2);
  const report = await runReplay({ runsPerVariant: Number.isFinite(runsArg) && runsArg > 0 ? runsArg : 2 });
  console.log(JSON.stringify(report, null, 2));
}
