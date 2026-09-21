import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SIGNALS = {
  synchronization: [
    ['lock', /\b(?:lock|mutex|semaphore|rwlock)\b/i],
    ['atomic', /\b(?:atomic|compare[-_ ]?and[-_ ]?swap|cas)\b/i],
    ['transaction', /\btransaction\b/i],
    ['git-ref-update', /\b(?:update-ref|updateRef)\b/i],
  ],
  durableState: [
    ['state', /\bstate\b/i],
    ['store', /\bstore\b/i],
    ['persistence', /\b(?:persist|persistence|durable)\b/i],
    ['checkpoint-history', /\b(?:checkpoint|history)\b/i],
    ['git-state-commit', /\b(?:commit-tree|write-tree|read-tree)\b/i],
    ['file-write', /\b(?:writeFile|renameSync|atomicWrite)\b/i],
  ],
  multiActor: [
    ['worktree', /\bworktree\b/i],
    ['concurrency', /\b(?:concurrent|parallel|race|interleav)\w*\b/i],
    ['process-worker', /\b(?:process|worker|thread|actor)\b/i],
  ],
};

export function addedDiffText(diff) {
  return String(diff ?? '')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

function matchedSignals(text, entries) {
  return entries.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function detectReviewRisk({ diff = '' } = {}) {
  const added = addedDiffText(diff);
  const synchronization = matchedSignals(added, SIGNALS.synchronization);
  const durableState = matchedSignals(added, SIGNALS.durableState);
  const multiActor = matchedSignals(added, SIGNALS.multiActor);

  // Keep this deliberately narrow. We only escalate when the changed code
  // combines synchronization/transaction primitives with durable/shared state,
  // or durable state with explicit multi-actor concurrency semantics.
  const stateIntegrity = (
    synchronization.length > 0 && durableState.length > 0
  ) || (
    durableState.length >= 2 && multiActor.length > 0
  );

  return {
    version: 1,
    stateIntegrity,
    signals: {
      synchronization,
      durableState,
      multiActor,
    },
  };
}

export function detectReviewRiskFromContext({
  contextRoot = '.review-context',
} = {}) {
  const root = path.resolve(contextRoot);
  const diffPath = path.join(root, 'pr.diff');
  if (!fs.existsSync(diffPath)) throw new Error('PR diff is missing for deterministic risk classification');
  return detectReviewRisk({ diff: fs.readFileSync(diffPath, 'utf8') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const contextRoot = path.resolve(process.env.REVIEW_CONTEXT_DIR || '.review-context');
    const output = path.resolve(process.env.REVIEW_RISK_PATH || path.join(contextRoot, 'risk-profile.json'));
    const result = detectReviewRiskFromContext({ contextRoot });
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    console.log(
      'Deterministic review risk: stateIntegrity=' + String(result.stateIntegrity)
      + ' synchronization=' + result.signals.synchronization.join(',')
      + ' durableState=' + result.signals.durableState.join(',')
      + ' multiActor=' + result.signals.multiActor.join(','),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
