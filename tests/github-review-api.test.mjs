import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorFindings, assertPrUnmoved, githubJson, loadAnchors } from '../scripts/github-review-api.mjs';

const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
const patch = '@@ -1,1 +1,2 @@\n a\n+b';

test('githubJson needs a token, times out per request and reports the failure body', async () => {
  await assert.rejects(githubJson('u', '', async () => reply({})), /Missing GH_TOKEN/);
  let seen;
  await githubJson('u', 't', async (url, init) => { seen = init; return reply({}); }, { method: 'POST', timeoutMs: 5 });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.Authorization, 'Bearer t');
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal('timeoutMs' in seen, false);
  await assert.rejects(githubJson('u', 't', async () => reply({ message: 'nope' }, false, 403)), /HTTP 403.*nope/);
});

test('assertPrUnmoved refuses a moved base or head', async () => {
  const ctx = { owner: 'o', repo: 'r', prNumber: 1, baseSha: 'b', headSha: 'h', token: 't' };
  await assertPrUnmoved({ ...ctx, fetchImpl: async () => reply({ base: { sha: 'b' }, head: { sha: 'h' } }) });
  await assert.rejects(assertPrUnmoved({ ...ctx, fetchImpl: async () => reply({ base: { sha: 'x' }, head: { sha: 'h' } }) }), /base moved before publish/);
  await assert.rejects(assertPrUnmoved({ ...ctx, when: 'while publishing', fetchImpl: async () => reply({ base: { sha: 'b' }, head: { sha: 'x' } }) }), /head moved while publishing/);
});

test('loadAnchors pages through the file list and anchorFindings splits inline from unanchored', async () => {
  const pages = [];
  const files = Array.from({ length: 100 }, (_, i) => ({ filename: i === 0 ? 'a.js' : `f${i}.js`, patch }));
  const fetchImpl = async (url) => { pages.push(url); return reply(url.endsWith('&page=1') ? files : []); };
  const anchors = await loadAnchors({ owner: 'o', repo: 'r', prNumber: 1, token: 't', fetchImpl });
  assert.equal(pages.length, 2);
  const { inline, unanchored } = anchorFindings(anchors,
    [{ path: 'a.js', line: 2, title: 'T', severity: 'P2' }, { path: 'missing.js', line: 1, title: 'U', severity: 'P2' }],
    (finding) => `**${finding.title}**`);
  assert.equal(inline.length, 1);
  assert.equal(inline[0].path, 'a.js');
  assert.match(inline[0].body, /^\*\*T\*\*/);
  assert.deepEqual(unanchored.map((finding) => finding.title), ['U']);
});
