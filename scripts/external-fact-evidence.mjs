// Trusted, bounded probes for external premises in material review findings.
// Repository text is untrusted: all probe URLs are constructed for api.github.com.
// Do not let ordinary workflow bugs or generic words like "provider" suppress
// a real finding. Only an explicit claim that a SPECIFIC Action ref is absent
// qualifies for deterministic external verification.
const ACTION_REF = /(?<![A-Za-z0-9_.\/-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)\b/g;
// Absence must directly modify the reference, not "missing permissions" or
// another local defect in the same title, body, or workflow.
const REF_ABSENT_BEFORE = /(?:\b(?:non[- ]existent|unreleased|unpublished|unresolvable)\s+(?:(?:GitHub\s+)?(?:Action\s+)?(?:ref(?:erence)?|tag|version|branch)\s+)?|\b(?:missing|invalid|unknown|unavailable)\s+(?:(?:GitHub\s+)?(?:Action\s+)?(?:ref(?:erence)?|tag|version|branch)\s+))\s*[`'"]?\s*$/i;
const REF_ABSENT_AFTER = /^\s*[`'"]?\s*(?:,\s*which\s+)?(?:(?:ref(?:erence)?|tag|version|branch)\s+(?:does\s+not|doesn't)\s+exist|does\s+not\s+exist|doesn't\s+exist|cannot\s+(?:be\s+)?resolved|can't\s+(?:be\s+)?resolved|(?:is|was)\s+(?:non[- ]existent|unreleased|unpublished|not\s+(?:found|published|released|available)))(?=$|[.,;:)\s])/i;
const API_TIMEOUT_MS = 5_000;

export function classifyExternalPremise(finding) {
  // Keep the independent statements separate. A "missing permissions" title
  // must never attach its absence predicate to an Action in another field.
  const statements = [finding?.title, finding?.body, finding?.failurePath]
    .filter(value => typeof value === 'string');
  const workflowPath = /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/i.test(String(finding?.path ?? ''));

  for (const statement of statements) {
    if (!workflowPath && !/\b(?:GitHub\s+Actions?|Action\s+ref|Action\s+version)\b/i.test(statement)) continue;
    for (const action of statement.matchAll(ACTION_REF)) {
      const before = statement.slice(Math.max(0, action.index - 140), action.index);
      const after = statement.slice(action.index + action[0].length, action.index + action[0].length + 120);
      if (!REF_ABSENT_BEFORE.test(before) && !REF_ABSENT_AFTER.test(after)) continue;
      const [, owner, repo, ref] = action;
      if (owner.length <= 100 && repo.length <= 100 && ref.length <= 100
          && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner)
          && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)
          && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ref)) {
        return { kind: 'github-action-ref', owner, repo, ref };
      }
    }
  }
  // All other findings, including generic third-party/API speculation, stay
  // on the original Gemini evidence-validation path. Never auto-demote them.
  return { kind: 'code-only' };
}

async function fetchOfficial(url, { fetchImpl, token }) {
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jiaze-review-bot',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (res.status === 404) return { status: 'not-found' };
    if (!res.ok) return { status: 'unknown', detail: `HTTP ${res.status}` };
    return { status: 'ok', data: await res.json() };
  } catch {
    return { status: 'unknown', detail: 'GitHub reference probe failed' };
  }
}

export async function assessExternalPremise(finding, { fetchImpl = fetch, token = '' } = {}) {
  const kind = classifyExternalPremise(finding);
  if (kind.kind === 'code-only') return null;
  const { owner, repo, ref } = kind;
  const target = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  // A commit SHA can be a valid Action ref without a tag/branch. Fail closed instead.
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    return { disposition: 'uncertain', reason: 'SHA-pinned GitHub Action reference needs commit verification; tag/branch lookup is insufficient.', evidence: [] };
  }
  const observations = [];
  for (const namespace of ['tags', 'heads']) {
    const url = `${target}/git/ref/${namespace}/${encodeURIComponent(ref)}`;
    const result = await fetchOfficial(url, { fetchImpl, token });
    if (result.status === 'unknown') {
      return { disposition: 'uncertain', reason: `Could not verify the official GitHub Action reference (${result.detail}).`, evidence: [] };
    }
    if (result.status === 'ok') {
      const actual = `refs/${namespace}/${ref}`;
      if (result.data?.ref !== actual || !/^[0-9a-f]{40}$/i.test(result.data?.object?.sha ?? '')) {
        return { disposition: 'uncertain', reason: 'GitHub returned an unrecognizable action-ref response.', evidence: [] };
      }
      return {
        disposition: 'reject',
        reason: `Official GitHub ${actual} exists at ${result.data.object.sha}; the claimed non-existent Action ref is contradicted.`,
        evidence: [`${url} (200, ${result.data.object.sha})`],
      };
    }
    observations.push(`${url} (404)`);
  }
  // Both refs can appear absent if the action repo is private/inaccessible; only
  // consider this authoritative if GitHub also confirms the actual repository.
  const metadata = await fetchOfficial(target, { fetchImpl, token });
  if (metadata.status !== 'ok' || String(metadata.data?.full_name ?? '').toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    return { disposition: 'uncertain', reason: 'Tag and branch were not found, but repository access/existence could not be established.', evidence: [] };
  }
  return {
    disposition: 'verified-absent',
    reason: `Official GitHub refs/tags/${ref} and refs/heads/${ref} both returned 404 for ${owner}/${repo}.`,
    evidence: [`${target} (200)`, ...observations],
  };
}

export function applyExternalEvidence(verdict, assessment) {
  if (!assessment) return verdict;
  if (assessment.disposition === 'reject') {
    return { ...verdict, verdict: 'REJECTED', reason: assessment.reason, evidence: assessment.evidence };
  }
  if (assessment.disposition === 'uncertain') {
    if (verdict.verdict !== 'CONFIRMED') return verdict;
    return { ...verdict, verdict: 'UNCERTAIN', reason: assessment.reason, evidence: assessment.evidence };
  }
  if (assessment.disposition === 'verified-absent' && verdict.verdict === 'CONFIRMED') {
    return { ...verdict, reason: `${verdict.reason} ${assessment.reason}`, evidence: [...verdict.evidence, ...assessment.evidence].slice(0, 6) };
  }
  return verdict;
}
