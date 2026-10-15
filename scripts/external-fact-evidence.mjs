// Trusted, bounded probes for external premises in material review findings.
// Repository text is untrusted: all probe URLs are constructed for api.github.com.
const ACTION_REF = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)*@([A-Za-z0-9_.-]+)\b/g;
const ABSENT_CLAIM = /\b(?:non[- ]existent|does(?:n't| not) exist|never (?:published|released)|not (?:found|published|released|available)|missing|unavailable|unable to resolve|cannot (?:be )?resolved|can't resolve|invalid (?:ref|version|tag|release)|no (?:[A-Za-z0-9.-]+\s+){0,6}(?:tag|branch|release|version)|only (?:has|supports) (?:releases|versions) up to)\b/i;
const EXTERNAL_SOURCE = /\b(?:GitHub Actions?|GitHub API|Google API|Stripe API|OpenAI API|Anthropic API|AWS API|Azure API|Cloudflare API|third[- ]party|external|upstream|vendor|provider|official (?:release|docs|documentation|version)|npm|pypi|maven|nuget|crates\.io|package registry|published (?:release|version)|SDK)\b/i;
const EXTERNAL_ASSERTION = /\b(?:version|release|tag|branch|API|SDK|endpoint|removed|deprecated|unsupported|support|missing|unavailable|published|returns?|responds?|rejected|not found|non[- ]existent|exist|resolve|breaks?|fails?|[45]0[1349])\b/i;
const API_TIMEOUT_MS = 5_000;

export function classifyExternalPremise(finding) {
  const text = [finding?.title, finding?.failurePath, finding?.body, finding?.riskClass]
    .filter(v => typeof v === 'string').join('\n');
  const action = ACTION_REF.exec(text);
  ACTION_REF.lastIndex = 0;
  if (action && ABSENT_CLAIM.test(text) && (/\.github\/workflows\//i.test(String(finding?.path ?? '')) || /\b(?:GitHub Action|actions\/|uses\s*:|workflow|action ref|action version)\b/i.test(text))) {
    const [, owner, repo, ref] = action;
    if (owner.length <= 100 && repo.length <= 100 && ref.length <= 100
        && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner)
        && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)
        && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(ref)) {
      return { kind: 'github-action-ref', owner, repo, ref };
    }
  }
  if ((action && /\.github\/workflows\//i.test(String(finding?.path ?? '')))
      || (EXTERNAL_SOURCE.test(text) && EXTERNAL_ASSERTION.test(text))) {
    return { kind: 'other-external' };
  }
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
  if (kind.kind === 'other-external') {
    return {
      disposition: 'uncertain',
      reason: 'This claim depends on an external release, dependency, or API fact. No authoritative probe is available for it; code snippets and another model assertion are not proof.',
      evidence: [],
    };
  }
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
