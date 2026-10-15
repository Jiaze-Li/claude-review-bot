import fs from 'node:fs';
import path from 'node:path';

// A model-authored sentence is not an independently checked citation.
// Require at least one substantive source quote that exists both in the
// validator's supplied context and in the exact-HEAD checkout.
const MIN_QUOTE_CHARS = 12;
const MAX_ANCHORS = 4;

export function requireGroundedSourceEvidence(verdict, { repoRoot, context }) {
  if (verdict.verdict !== 'CONFIRMED') return verdict;

  const grounded = (Array.isArray(verdict.sourceAnchors) ? verdict.sourceAnchors : [])
    .slice(0, MAX_ANCHORS)
    .filter((anchor) => isGroundedSourceAnchor(anchor, { repoRoot, context }));
  if (grounded.length > 0) return { ...verdict, sourceAnchors: grounded };

  return {
    ...verdict,
    verdict: 'UNCERTAIN',
    reason: ('Downgraded: CONFIRMED had no verifiable source quote in the reviewed HEAD and supplied context. '
      + verdict.reason).slice(0, 1600),
    sourceAnchors: [],
  };
}

export function isGroundedSourceAnchor(anchor, { repoRoot, context }) {
  if (!anchor || typeof anchor !== 'object') return false;
  const { path: relative, line, quote } = anchor;
  if (typeof relative !== 'string' || typeof quote !== 'string'
      || !Number.isInteger(line) || line < 1 || line > 1_000_000
      || !relative || relative.includes('\\') || relative.includes('\0')
      || quote.includes('\n') || quote.includes('\r') || quote.includes('\0')) return false;

  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === '.' || normalized === '..'
      || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return false;

  const normalizeSpaces = (text) => text.replace(/\s+/g, ' ').trim();
  const excerpt = normalizeSpaces(quote);
  if (excerpt.replace(/\s/g, '').length < MIN_QUOTE_CHARS || excerpt.length > 220) return false;

  try {
    const rootReal = fs.realpathSync(repoRoot);
    const sourceReal = fs.realpathSync(path.resolve(rootReal, relative));
    if (!sourceReal.startsWith(rootReal + path.sep)) return false;
    if (!fs.statSync(sourceReal).isFile()) return false;

    const source = fs.readFileSync(sourceReal, 'utf8').split('\n');
    if (line > source.length) return false;
    const sourceLine = source[line - 1].replace(/\r$/, '');
    if (!normalizeSpaces(sourceLine).includes(excerpt)) return false;

    // Never verify citations against a file the validator did not actually see.
    const sections = String(context || '').replace(/\r/g, '').split(/\n(?=## )/);
    const expectedHeaders = [
      `## Primary file: ${relative}\n`,
      `## Related code: ${relative} (matched:`,
      `## Related test/code: ${relative} (matched:`,
    ];
    return sections.some((section) =>
      expectedHeaders.some((header) => section.startsWith(header))
      && section.includes(`\n${line}: ${sourceLine}`));
  } catch {
    // No verified quote means no automatic blocking finding.
    return false;
  }
}
