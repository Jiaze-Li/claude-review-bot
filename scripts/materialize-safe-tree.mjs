import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceDir = process.env.SOURCE_REPO_DIR ?? 'target';
const outputDir = process.env.OUTPUT_DIR ?? 'safe-target';
const contextDir = process.env.REVIEW_CONTEXT_DIR ?? '.review-context';
const headSha = process.env.HEAD_SHA;

if (!headSha) throw new Error('HEAD_SHA is required');

const sourceRoot = path.resolve(sourceDir);
const outputRoot = path.resolve(outputDir);
const contextRoot = path.resolve(contextDir);

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(contextRoot, { recursive: true, mode: 0o700 });

const listing = gitBuffer(['ls-tree', '-r', '-z', '--full-tree', headSha]);
const records = listing.toString('utf8').split('\0').filter(Boolean);
const skipped = [];
let materialized = 0;

for (const record of records) {
  const tab = record.indexOf('\t');
  if (tab < 0) throw new Error(`Unexpected git ls-tree record: ${JSON.stringify(record)}`);

  const metadata = record.slice(0, tab);
  const repoPath = record.slice(tab + 1);
  const [mode, type, oid] = metadata.split(' ');

  if (!isSafeRepositoryPath(repoPath)) {
    throw new Error(`Unsafe repository path from Git tree: ${JSON.stringify(repoPath)}`);
  }

  if (isClaudeControlPath(repoPath)) {
    skipped.push(`${repoPath}\tcontrol-file`);
    continue;
  }

  // Only materialize ordinary blobs. Symlinks (120000), gitlinks/submodules
  // (160000), and any future special modes stay out of Claude's readable tree.
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
    skipped.push(`${repoPath}\tmode=${mode}\ttype=${type}`);
    continue;
  }

  const destination = path.resolve(outputRoot, ...repoPath.split('/'));
  if (destination !== outputRoot && !destination.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`Repository path escaped safe output root: ${JSON.stringify(repoPath)}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const blob = gitBuffer(['cat-file', 'blob', oid]);
  fs.writeFileSync(destination, blob, { mode: 0o600 });
  materialized += 1;
}

fs.writeFileSync(
  path.join(contextRoot, 'skipped-files.txt'),
  skipped.length ? `${skipped.join('\n')}\n` : '',
  { mode: 0o600 },
);

console.log(`Materialized ${materialized} regular file(s) into ${outputRoot}; skipped ${skipped.length}.`);

function gitBuffer(args) {
  const result = spawnSync('git', ['-C', sourceRoot, ...args], {
    encoding: null,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString('utf8') ?? ''}`);
  }
  return result.stdout;
}

function isSafeRepositoryPath(repoPath) {
  if (!repoPath || repoPath.includes('\0') || repoPath.startsWith('/')) return false;
  const segments = repoPath.split('/');
  return !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

function isClaudeControlPath(repoPath) {
  const segments = repoPath.split('/');
  const base = segments.at(-1);
  return segments.includes('.claude') ||
    base === 'CLAUDE.md' ||
    base === 'CLAUDE.local.md' ||
    base === '.mcp.json';
}
