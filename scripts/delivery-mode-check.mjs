// Used by the legacy workflow: is this PR on delivery-v1 (label or a delivery state comment by the bot)?
// If so, the whole legacy review job is skipped, so the legacy path can never overwrite a delivery result.
// An unreadable PR throws: the legacy job then does not run either (fail closed).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fetchLedgerSources } from './review-ledger-fetch.mjs';
import { BOT_LOGIN, DELIVERY_LABEL, readDeliveryState } from './delivery-protocol.mjs';

export async function isDeliveryPr({ target, prNumber, token, botLogin = BOT_LOGIN, fetchImpl = fetch }) {
  const [owner, repo] = target.split('/');
  const pr = await (await fetchImpl(`https://api.github.com/repos/${target}/pulls/${prNumber}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jiaze-review-bot' },
    signal: AbortSignal.timeout(20000),
  }).then((r) => { if (!r.ok) throw new Error(`GitHub API failed reading the PR (HTTP ${r.status})`); return r; })).json();
  if ((pr.labels ?? []).some((l) => l.name === DELIVERY_LABEL)) return true;
  const { records, reads } = await fetchLedgerSources({ owner, repo, number: Number(prNumber), token, fetchImpl });
  if (!reads?.complete) throw new Error('PR records could not be read in full');
  // Any state comment by the bot, valid or not, means delivery owns the PR.
  return readDeliveryState(records, { botLogin, repo: target, prNumber }).kind !== 'none';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const delivery = await isDeliveryPr({
      target: process.env.TARGET_REPO, prNumber: process.env.PR_NUMBER, token: process.env.GH_TOKEN,
      botLogin: process.env.EXPECTED_REVIEW_AUTHOR || BOT_LOGIN,
    });
    console.log(delivery ? 'Delivery-v1 PR: the legacy review is skipped.' : 'Not a delivery-v1 PR.');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `delivery=${delivery}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
