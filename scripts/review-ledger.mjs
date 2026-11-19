// The review ledger: the PR's own readable bot comments, read back as the one source of review facts.
//
// Every fact is plain visible text (`Key: value` lines, one JSON value per line). Nothing is base64 or hidden in
// an HTML comment. The newest COMPLETE Handoff is a full snapshot of the review session; Finding / Verdict / Event
// records are the per-problem history and are cross-checked against it. Anything that cannot be read in full, was
// edited or collapsed after the bot wrote it, or does not add up, STOPS the ledger: "not read" is never "no problem".

export const LEDGER_LIMITS = Object.freeze({
  maxIssueComments: 2000, maxReviews: 500, maxThreads: 2000, maxThreadComments: 250, pageSize: 100,
  maxPartBytes: 60_000,
});

export const LEDGER_CODES = Object.freeze({
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  READ_INCOMPLETE: 'READ_INCOMPLETE',
  STAGE_NOT_CLOSED: 'STAGE_NOT_CLOSED',
  HANDOFF_MISMATCH: 'HANDOFF_MISMATCH',
  HANDOFF_CHAIN_BROKEN: 'HANDOFF_CHAIN_BROKEN',
  RECORD_UNRECOVERABLE: 'RECORD_UNRECOVERABLE',
});

export const STAGES = Object.freeze(['first', 'verification', 'audit', 'closing']);
const VERDICTS = new Set(['FIXED', 'STILL_OPEN', 'UNCERTAIN', 'DISMISSED']);
const KINDS = new Set(['repair', 'dismissal']);

// ---------------------------------------------------------------------------------------------------------------
// Field lines: any plain JSON object <-> readable `path: json` lines.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function flattenFields(value, prefix = '') {
  const out = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      if (node.length === 0) out.push([path, '[]']);
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (node && typeof node === 'object') {
      const keys = Object.keys(node).filter((key) => node[key] !== undefined);
      if (keys.length === 0) out.push([path, '{}']);
      for (const key of keys) walk(node[key], IDENT.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`);
    } else {
      out.push([path, JSON.stringify(node === undefined ? null : node)]);
    }
  };
  walk(value, prefix);
  return out.filter(([path]) => path !== '');
}

function parsePath(path) {
  const tokens = [];
  let rest = path;
  const first = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  if (!first) return null;
  tokens.push(first[0]);
  rest = rest.slice(first[0].length);
  while (rest.length) {
    let match = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (match) { tokens.push(match[1]); rest = rest.slice(match[0].length); continue; }
    match = /^\[(\d+)\]/.exec(rest);
    if (match) { tokens.push(Number(match[1])); rest = rest.slice(match[0].length); continue; }
    match = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    if (match) {
      try { tokens.push(JSON.parse(match[1])); } catch { return null; }
      rest = rest.slice(match[0].length); continue;
    }
    return null;
  }
  return tokens;
}

// pairs: [[path, jsonText]] -> object. Returns null on any unreadable path or value.
export function unflattenFields(pairs) {
  const root = {};
  for (const [path, json] of pairs) {
    const tokens = parsePath(path);
    if (!tokens || tokens.some((t) => ['__proto__', 'constructor', 'prototype'].includes(t))) return null;
    let value;
    try { value = JSON.parse(json); } catch { return null; }
    let node = root;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const last = index === tokens.length - 1;
      if (last) {
        if (Array.isArray(node) !== (typeof token === 'number') && node !== root) return null;
        node[token] = value;
      } else {
        const next = typeof tokens[index + 1] === 'number' ? [] : {};
        if (node[token] === undefined) node[token] = next;
        node = node[token];
        if (node === null || typeof node !== 'object') return null;
      }
    }
  }
  return root;
}

// `path: json` lines that belong to `prefix`, read ONLY from the record's <details> block, so free text that a
// finding quotes in the visible part can never pose as a field.
function detailsLines(lines) {
  const start = lines.findIndex((line) => line.trim().startsWith('<details>'));
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && line.trim() === '</details>');
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

function fieldPairs(lines, prefix) {
  const pairs = [];
  const re = new RegExp(`^(${prefix}(?:\\.|\\[).+?): (.*)$`);
  for (const line of detailsLines(lines)) {
    const match = re.exec(line);
    if (match) pairs.push([match[1], match[2]]);
  }
  return pairs;
}

const clean = (value, max = 200) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/<!--|-->/g, '').trim().slice(0, max);
const usd = (value) => (Number.isFinite(value) ? value : 0).toFixed(2);

function keyValue(lines, key) {
  const prefix = `${key}: `;
  const line = lines.find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering (what the bot writes to the PR)

function sessionScalarFields(session) {
  const { findings, ...rest } = session; // eslint-disable-line no-unused-vars
  return flattenFields(rest, 'session');
}

function findingFieldPairs(findings) {
  return findings.flatMap((finding, index) => flattenFields(finding, `findings[${index}]`));
}

export function repairAttempts(findings, verdicts = []) {
  const heads = new Map();
  for (const verdict of verdicts) {
    if (verdict.kind !== 'repair') continue;
    if (!heads.has(verdict.findingId)) heads.set(verdict.findingId, new Set());
    heads.get(verdict.findingId).add(verdict.head);
  }
  return Object.fromEntries(findings.map((finding) => [finding.id, heads.get(finding.id)?.size ?? 0]));
}

// -> array of comment bodies (Part 1..n). Only the last one carries `Handoff: COMPLETE`.
export function renderHandoffParts({
  session, stage, seq, prev = null, recordIds = {}, attempts = {}, spendThisRun = 0, next = '', readyReason = '',
  intro = [], maxPartBytes = LEDGER_LIMITS.maxPartBytes,
} = {}) {
  if (!STAGES.includes(stage)) throw new Error(`unknown handoff stage "${stage}"`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error('handoff Seq must be a positive integer');
  const coverage = session.coverage && !session.coverage.complete
    ? `partial (${session.coverage.unreviewedCount ?? '?'} file(s) not reviewed)` : 'complete';
  const blocking = (session.findings ?? []).filter((f) => ['OPEN', 'UNCERTAIN'].includes(f.status)
    && (['P0', 'P1', 'P2'].includes(f.severity) || (f.severity === 'P3' && !f.downgradedFrom)));
  const ready = session.status === 'READY' && session.auditCompleted === true && coverage === 'complete' && blocking.length === 0;
  const table = [
    '| Finding | Severity | Status | Last checked HEAD | Repair attempts | Blocking | Record |',
    '|---|---|---|---|---|---|---|',
    ...(session.findings ?? []).map((f) => `| ${clean(f.id, 20)} | ${clean(f.severity, 4)} | ${clean(f.status, 20)} | ${clean(f.lastCheckedHead ?? '', 40)} | ${attempts[f.id] ?? 0} | ${blocking.includes(f) ? 'yes' : 'no'} | ${recordIds[f.id] ?? 'none'} |`),
  ];
  const fieldLines = [...sessionScalarFields(session), ...findingFieldPairs(session.findings ?? [])]
    .map(([path, json]) => `${path}: ${json}`);
  const wrap = (rows) => ['<details><summary>Full record fields</summary>', '', ...rows, '', '</details>'];
  const lineBytes = (line) => Buffer.byteLength(line, 'utf8') + 1;
  const sum = (rows) => rows.reduce((total, line) => total + lineBytes(line), 0);
  const summaryFor = (partText) => [
    `### Review Handoff · Seq ${seq} · ${stage}${partText ? ` · Part ${partText}` : ''}`,
    'Handoff: COMPLETE',
    `Stage: ${stage}`,
    `Seq: ${seq}`,
    ...(partText ? [`Part: ${partText}`] : []),
    `Prev: ${prev ?? 'none'}`,
    `Reviewed HEAD: ${session.lastReviewedHead}`,
    `Coverage: ${coverage}`,
    `Spend: this run $${usd(spendThisRun)} / cumulative $${usd(session.deepSpendUsd ?? 0)}`,
    `Ready: ${ready ? 'yes' : 'no'}${readyReason ? ` — ${clean(readyReason, 300)}` : ''}`,
    `Next: ${clean(next, 400) || 'none'}`,
    '',
    ...intro,
    ...(intro.length ? [''] : []),
    ...table,
  ];
  const lastReserve = sum(summaryFor('99/99')) + 200;
  const remaining = [...fieldLines];
  const middles = [];
  while (sum(remaining) > maxPartBytes - lastReserve) {
    const chunk = []; let size = 0; const cap = maxPartBytes - 600;
    while (remaining.length && size + lineBytes(remaining[0]) <= cap) { size += lineBytes(remaining[0]); chunk.push(remaining.shift()); }
    if (!chunk.length) throw new Error('a single record field exceeds the comment size limit');
    middles.push(chunk);
  }
  const total = middles.length + 1;
  const bodies = middles.map((chunk, index) => [
    `### Review Handoff · Seq ${seq} · ${stage} · Part ${index + 1}/${total}`,
    'Handoff: PART',
    `Seq: ${seq}`,
    `Part: ${index + 1}/${total}`,
    '',
    ...wrap(chunk),
  ].join('\n'));
  bodies.push([...summaryFor(total > 1 ? `${total}/${total}` : ''), '', ...wrap(remaining)].join('\n'));
  if (bodies.some((body) => Buffer.byteLength(body, 'utf8') > maxPartBytes)) throw new Error('a handoff part exceeds the comment size limit');
  return bodies;
}

export function renderFindingRecord(finding, { headSha } = {}) {
  const location = `${finding.path}${finding.line ? `:${finding.line}` : ''}`;
  const blocking = ['P0', 'P1', 'P2'].includes(finding.severity) || (finding.severity === 'P3' && !finding.downgradedFrom);
  return [
    `### Finding ${finding.id} · ${finding.severity} · ${clean(finding.title, 200)}`,
    `Location: ${clean(location, 300)}`,
    `First seen at: ${finding.introducedHead ?? headSha ?? 'unknown'}`,
    `Failure condition: ${clean(finding.failurePath || finding.body, 600)}`,
    `Blocking: ${blocking ? 'yes' : 'no'}`,
    '',
    `> ${clean(finding.body, 1500)}`,
    '',
    '<details><summary>Full record fields</summary>',
    '',
    ...flattenFields(finding, 'finding').map(([p, j]) => `${p}: ${j}`),
    '',
    '</details>',
  ].join('\n');
}

export function renderVerdictRecord({ finding, verdict, head, kind, attempt = null, range = null, reason = '', evidence = [], claimsRead = [], run = '' }) {
  if (!VERDICTS.has(verdict)) throw new Error(`unknown verdict "${verdict}"`);
  if (!KINDS.has(kind)) throw new Error(`unknown verdict kind "${kind}"`);
  return [
    `### Review Verdict · ${finding.id} · ${verdict}`,
    `Verdict: ${verdict}`,
    `Finding: ${finding.id}`,
    `HEAD: ${head}`,
    `Kind: ${kind}`,
    ...(kind === 'repair' && attempt != null ? [`Attempt: ${attempt}`] : []),
    `Range: ${range ?? 'none'}`,
    `Reason: ${clean(reason, 800)}`,
    `Evidence: ${evidence.map((e) => clean(e, 200)).join(' · ') || 'none'}`,
    `Claims read: ${claimsRead.map((c) => clean(c, 100)).join(' · ') || 'none'}`,
    `Run: ${clean(run, 100) || 'none'}`,
    '',
    '<details><summary>Full record fields</summary>',
    '',
    ...flattenFields(finding, 'finding').map(([p, j]) => `${p}: ${j}`),
    '',
    '</details>',
  ].join('\n');
}

export function renderEventRecord({ findingId, attempt }) {
  return [
    `### Review Event · ${findingId} · REPEATED_REWORK`,
    'Event: REPEATED_REWORK',
    `Finding: ${findingId}`,
    `Attempt: ${attempt}`,
    `Key: ${findingId}#repeated-rework`,
    'This finding has now been verified against its third independent repair attempt. It is a signal only; repairs may continue.',
  ].join('\n');
}

export function renderReceipt({ commentId, version, result }) {
  return [`### Review Receipt`, `Handled: comment ${commentId} (version ${version}) → ${clean(result, 300)}`].join('\n');
}

// `session` (optional): the in-progress session snapshot, so a run that dies leaves its state readable on the PR.
export function renderRunStart({ runId, reservedUsd, stage, head, session = null }) {
  return ['### Review Run Start', `Run: ${runId} · reserved ${usd(reservedUsd)} · ${stage} · ${head}`,
    `Run id: ${runId}`, `Reserved: ${usd(reservedUsd)}`, `Stage: ${stage}`, `HEAD: ${head}`,
    ...(session ? ['', ...detailsBlock(snapshotLines(session))] : [])].join('\n');
}

function snapshotLines(session) {
  return [...sessionScalarFields(session), ...findingFieldPairs(session.findings ?? [])].map(([path, json]) => `${path}: ${json}`);
}
function detailsBlock(rows) {
  return ['<details><summary>Full record fields</summary>', '', ...rows, '', '</details>'];
}

// The session the bot is about to save, written visibly INSIDE the review it posts. If the save that follows
// never happens, the next run finds this and completes the handoff without asking a model again.
export function renderPendingHandoff({ session, sourceCommentId }) {
  const id = String(sourceCommentId ?? '');
  if (!/^[1-9]\d*$/.test(id)) throw new Error('invalid pending source comment id');
  return [`### Review Pending Handoff · comment ${id}`, 'Handoff: PENDING', `Source comment: ${id}`,
    `Reviewed HEAD: ${session.lastReviewedHead}`, ...detailsBlock(snapshotLines(session))].join('\n');
}

export function parsePendingHandoff(body) {
  if (typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^### Review Pending Handoff · comment [1-9]\d*$/.test(line.trim()));
  if (start === -1) return null;
  const block = lines.slice(start);
  const sourceCommentId = keyValue(block, 'Source comment');
  const parsed = unflattenFields([...fieldPairs(block, 'session'), ...fieldPairs(block, 'findings')]);
  if (!sourceCommentId || !parsed?.session) return null;
  return { sourceCommentId, session: { ...parsed.session, findings: parsed.findings ?? [] } };
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing a single bot comment body into a ledger record (or null when it is not one)

export function parseRecord(body) {
  if (typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/);
  const head = lines.find((line) => line.trim() !== '')?.trim() ?? '';
  let match;
  // Records from the removed import stage are old-format content: ignored like any other unknown comment.
  if (/^### Review Handoff · Seq [1-9]\d* · import(?: · Part \d+\/\d+)?$/.test(head)) return null;
  if (/^### Review Handoff · /.test(head)) return parseHandoffPart(lines);
  if ((match = /^### Finding (F\d{3,}) · (P[0-3]) · /.exec(head))) return parseFinding(lines, match[1]);
  if ((match = /^### Review Verdict · (F\d{3,}) · /.exec(head))) return parseVerdict(lines, match[1]);
  if (/^### Review Event · /.test(head)) return parseEvent(lines);
  if (head === '### Review Receipt') return parseReceipt(lines);
  if (head === '### Review Run Start') return parseRunStart(lines);
  return null;
}

const bad = (type, why) => ({ type, error: why });

function parseHandoffPart(lines) {
  const seq = Number(keyValue(lines, 'Seq'));
  const partText = keyValue(lines, 'Part');
  const status = keyValue(lines, 'Handoff');
  if (!Number.isInteger(seq) || seq < 1 || !['COMPLETE', 'PART'].includes(status)) return bad('handoff', 'handoff header is unreadable');
  let part = 1; let total = 1;
  if (partText) {
    const m = /^(\d+)\/(\d+)$/.exec(partText);
    if (!m) return bad('handoff', 'handoff part number is unreadable');
    part = Number(m[1]); total = Number(m[2]);
  }
  const session = fieldPairs(lines, 'session');
  const findings = fieldPairs(lines, 'findings');
  const complete = status === 'COMPLETE';
  const base = { type: 'handoff', seq, part, total, complete, sessionPairs: session, findingPairs: findings };
  if (!complete) return base;
  const stage = keyValue(lines, 'Stage');
  const prevText = keyValue(lines, 'Prev');
  const reviewed = keyValue(lines, 'Reviewed HEAD');
  const ready = keyValue(lines, 'Ready');
  if (!STAGES.includes(stage) || !prevText || !/^[0-9a-f]{40}$/i.test(reviewed ?? '') || !ready) return bad('handoff', 'handoff summary fields are unreadable');
  const rows = lines.filter((line) => /^\| F\d{3,} \|/.test(line)).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return { id: cells[0], severity: cells[1], status: cells[2], lastCheckedHead: cells[3], attempts: Number(cells[4]), blocking: cells[5] === 'yes', record: cells[6] };
  });
  return {
    ...base, stage, prev: prevText === 'none' ? null : prevText, reviewedHead: reviewed.toLowerCase(),
    coverage: keyValue(lines, 'Coverage'), ready: /^yes\b/.test(ready), next: keyValue(lines, 'Next'), rows,
  };
}

function parseFinding(lines, id) {
  const finding = unflattenFields(fieldPairs(lines, 'finding'))?.finding;
  if (!finding || finding.id !== id) return bad('finding', 'finding record id does not match its fields');
  return { type: 'finding', id, finding };
}

function parseVerdict(lines, id) {
  const verdict = keyValue(lines, 'Verdict');
  const kind = keyValue(lines, 'Kind');
  const head = keyValue(lines, 'HEAD');
  const named = keyValue(lines, 'Finding');
  const finding = unflattenFields(fieldPairs(lines, 'finding'))?.finding;
  if (!VERDICTS.has(verdict) || !KINDS.has(kind) || !/^[0-9a-f]{40}$/i.test(head ?? '') || named !== id || !finding || finding.id !== id) {
    return bad('verdict', 'verdict record is unreadable');
  }
  const attempt = keyValue(lines, 'Attempt');
  return { type: 'verdict', findingId: id, verdict, kind, head: head.toLowerCase(), attempt: attempt == null ? null : Number(attempt), finding };
}

function parseEvent(lines) {
  const event = keyValue(lines, 'Event');
  const findingId = keyValue(lines, 'Finding');
  const attempt = Number(keyValue(lines, 'Attempt'));
  const key = keyValue(lines, 'Key');
  if (event !== 'REPEATED_REWORK' || !/^F\d{3,}$/.test(findingId ?? '') || !Number.isInteger(attempt) || !key) return bad('event', 'event record is unreadable');
  return { type: 'event', event, findingId, attempt, key };
}

function parseReceipt(lines) {
  const m = /^Handled: comment (\d+) \(version ([^)]*)\) → (.*)$/.exec(lines.find((line) => line.startsWith('Handled: ')) ?? '');
  if (!m) return bad('receipt', 'receipt record is unreadable');
  return { type: 'receipt', key: `${m[1]}@${m[2]}`, commentId: m[1], version: m[2], result: m[3] };
}

function parseRunStart(lines) {
  const runId = keyValue(lines, 'Run id');
  const reserved = Number(keyValue(lines, 'Reserved'));
  const stage = keyValue(lines, 'Stage');
  const head = keyValue(lines, 'HEAD');
  if (!runId || !Number.isFinite(reserved) || !stage || !head) return bad('run', 'run start record is unreadable');
  const sessionPairs = fieldPairs(lines, 'session');
  const findingPairs = fieldPairs(lines, 'findings');
  return { type: 'run', runId, reservedUsd: reserved, stage, head, sessionPairs, findingPairs, hasSnapshot: sessionPairs.length > 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Rebuilding the ledger from the PR's records

const normalizeLogin = (login) => String(login ?? '').replace(/\[bot\]$/i, '').toLowerCase();

function order(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  const x = BigInt(/^\d+$/.test(a.id) ? a.id : 0); const y = BigInt(/^\d+$/.test(b.id) ? b.id : 0);
  return x < y ? -1 : x > y ? 1 : 0;
}

const stopped = (code, message, details = []) => ({ state: 'stopped', code, message, details });

// records: [{ id, source, threadId?, createdAt, body, login, type, lastEditedAt, minimizedReason }]
// reads: { complete: boolean, problems?: string[] } — the fetch layer's statement that EVERYTHING was read.
// closingStage: the caller is about to write the Handoff that closes the stage whose records already exist, so
// finding/verdict records newer than the last handoff are expected rather than a stop.
export function buildLedger({ records, botLogin, reads = { complete: true }, headSha = null, closingStage = false } = {}) {
  if (!reads.complete) {
    return stopped(LEDGER_CODES.READ_INCOMPLETE, `The PR's review records could not be read in full (${(reads.problems ?? ['unknown']).join('; ')}); stopping instead of assuming there is nothing there.`);
  }
  const bot = normalizeLogin(botLogin);
  if (!bot) return stopped(LEDGER_CODES.READ_INCOMPLETE, 'The expected bot login is not configured.');
  const mine = records.filter((r) => normalizeLogin(r.login) === bot && String(r.type ?? '').toLowerCase() === 'bot')
    .sort(order);

  const ledger = []; const summaries = []; const edited = [];
  for (const record of mine) {
    const body = String(record.body ?? '');
    const parsed = parseRecord(body);
    if (parsed) {
      if (record.lastEditedAt || record.minimizedReason) edited.push(`${record.source} ${record.id}${record.minimizedReason ? ' (collapsed)' : ' (edited)'}`);
      if (parsed.error) return stopped(LEDGER_CODES.RECORD_UNRECOVERABLE, `A review record (${record.source} ${record.id}) is unreadable: ${parsed.error}.`, [record.id]);
      ledger.push({ ...parsed, recordId: record.id, createdAt: record.createdAt, source: record.source, order: ledger.length });
    } else if (body.includes('<!-- jiaze-review-session:v1 -->')) {
      summaries.push({ id: record.id, body, createdAt: record.createdAt });
    }
  }
  if (edited.length) {
    return stopped(LEDGER_CODES.INTEGRITY_FAILED, `Review records were changed after the bot wrote them: ${edited.join(', ')}. The bot never edits its own records, so this review history cannot be trusted.`, edited);
  }

  const handoffParts = ledger.filter((r) => r.type === 'handoff');
  const handoffs = [];
  const bySeq = new Map();
  for (const part of handoffParts) {
    if (!bySeq.has(part.seq)) bySeq.set(part.seq, []);
    bySeq.get(part.seq).push(part);
  }
  const incomplete = [];
  const setAsideHandoffs = [];
  for (let [seq, parts] of [...bySeq].sort((a, b) => a[0] - b[0])) {
    let finals = parts.filter((p) => p.complete);
    // Two writers that both passed the Seq check close the same Seq: the first COMPLETE handoff stands, everything
    // the later one wrote for that Seq is set aside (and named) instead of stopping the review for good.
    if (finals.length > 1) {
      const first = finals.reduce((a, b) => (b.order < a.order ? b : a));
      setAsideHandoffs.push({ seq, kept: first.recordId, ignored: finals.filter((f) => f !== first).map((f) => f.recordId) });
      parts = parts.filter((p) => p.order <= first.order);
      finals = [first];
    }
    if (finals.length !== 1) { incomplete.push(seq); continue; }
    const final = finals[0];
    const wanted = Array.from({ length: final.total }, (_, i) => i + 1);
    const present = parts.filter((p) => p.total === final.total).sort((a, b) => a.part - b.part);
    if (present.length !== final.total || !present.every((p, i) => p.part === wanted[i]) || present.at(-1) !== final) { incomplete.push(seq); continue; }
    handoffs.push({ ...final, parts: present, firstOrder: present[0].order, lastOrder: final.order, commentId: final.recordId });
  }
  if (incomplete.length) {
    return stopped(LEDGER_CODES.STAGE_NOT_CLOSED, `Review handoff Seq ${incomplete.join(', ')} is missing parts or its COMPLETE line; the previous review stage did not finish.`, incomplete);
  }
  handoffs.sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < handoffs.length; index += 1) {
    const h = handoffs[index];
    const expectedPrev = index === 0 ? null : handoffs[index - 1].commentId;
    if (h.seq !== index + 1 || h.prev !== expectedPrev || (index > 0 && h.lastOrder < handoffs[index - 1].lastOrder)) {
      return stopped(LEDGER_CODES.HANDOFF_CHAIN_BROKEN, `The review handoff chain is broken at Seq ${h.seq} (expected Seq ${index + 1}, Prev ${expectedPrev ?? 'none'}, found Prev ${h.prev ?? 'none'}).`, [h.commentId]);
    }
  }

  const findingRecords = ledger.filter((r) => r.type === 'finding');
  const verdicts = ledger.filter((r) => r.type === 'verdict');
  const events = ledger.filter((r) => r.type === 'event');
  const receipts = new Set(ledger.filter((r) => r.type === 'receipt').map((r) => r.key));
  const runs = ledger.filter((r) => r.type === 'run');

  const verdictByKey = new Map();
  const setAside = [];
  for (const v of verdicts) {
    const key = `${v.findingId}@${v.head}/${v.kind}`;
    const prior = verdictByKey.get(key);
    if (!prior) verdictByKey.set(key, v);
    // Two runs that raced to the same finding, HEAD and kind: the first verdict written stands and the later one is
    // set aside (and named), instead of stopping the whole review for good over a record nobody can edit away.
    else if (prior.verdict !== v.verdict) setAside.push({ key, kept: prior.recordId, ignored: v.recordId });
  }
  const uniqueVerdicts = [...verdictByKey.values()].sort((a, b) => a.order - b.order);
  const attemptsOf = (findings) => repairAttempts(findings, uniqueVerdicts);

  const snapshotOf = (carrier) => {
    const parsed = unflattenFields([...carrier.sessionPairs, ...carrier.findingPairs]);
    return parsed?.session ? { ...parsed.session, findings: parsed.findings ?? [] } : null;
  };
  const lastRunSnapshot = [...runs].reverse().find((r) => r.hasSnapshot) ?? null;
  const projection = summaries.length ? { id: summaries.at(-1).id, body: summaries.at(-1).body } : null;

  if (handoffs.length === 0 && lastRunSnapshot) {
    const session = snapshotOf(lastRunSnapshot);
    if (!session) return stopped(LEDGER_CODES.RECORD_UNRECOVERABLE, `The running review's state (comment ${lastRunSnapshot.recordId}) is unreadable.`, [lastRunSnapshot.recordId]);
    return { state: 'ok', session, handoff: null, handoffs: [], inProgress: true, findingRecords: findingRecords.map((r) => ({ id: r.id, recordId: r.recordId, source: r.source })), attempts: repairAttempts(session.findings ?? [], uniqueVerdicts), receipts, runs, events: [], verdicts: uniqueVerdicts, projection };
  }
  if (handoffs.length === 0) {
    if (!closingStage && (findingRecords.length || verdicts.length || events.length)) {
      return stopped(LEDGER_CODES.STAGE_NOT_CLOSED, 'Finding or verdict records exist but no review stage was ever closed with a COMPLETE handoff.', []);
    }
    return { state: 'new', session: null, findingRecords: findingRecords.map((r) => ({ id: r.id, recordId: r.recordId, source: r.source })), receipts, runs, attempts: {}, events: [], verdicts: uniqueVerdicts, projection };
  }

  const latest = handoffs.at(-1);
  // Anything the bot wrote about findings AFTER the last handoff belongs to a stage that never closed.
  const unclosed = ledger.filter((r) => ['finding', 'verdict', 'event'].includes(r.type) && r.order > latest.lastOrder);
  if (unclosed.length && !closingStage) {
    return stopped(LEDGER_CODES.STAGE_NOT_CLOSED, `The previous review stage wrote ${unclosed.length} record(s) after its last handoff (Seq ${latest.seq}) and never closed; ${unclosed.map((r) => `${r.type} ${r.recordId}`).join(', ')}.`, unclosed.map((r) => r.recordId));
  }

  // The snapshot comes from the final handoff's parts (field lines may be spread over several parts).
  const sessionPairs = latest.parts.flatMap((p) => p.sessionPairs);
  const findingPairs = latest.parts.flatMap((p) => p.findingPairs);
  const sessionOnly = unflattenFields(sessionPairs);
  const findingsObj = unflattenFields(findingPairs);
  if (!sessionOnly?.session || (findingPairs.length && !Array.isArray(findingsObj?.findings))) {
    return stopped(LEDGER_CODES.RECORD_UNRECOVERABLE, `Review handoff Seq ${latest.seq} has unreadable session fields.`, [latest.commentId]);
  }
  const session = { ...sessionOnly.session, findings: findingsObj?.findings ?? [] };

  // The table must describe exactly the findings in the snapshot.
  const table = latest.rows;
  const mismatch = [];
  if (table.length !== session.findings.length) mismatch.push(`table lists ${table.length} finding(s) but the snapshot has ${session.findings.length}`);
  session.findings.forEach((finding, index) => {
    const row = table[index];
    if (!row || row.id !== finding.id || row.status !== finding.status || row.severity !== finding.severity) {
      mismatch.push(`${finding.id}: table row differs from the snapshot`);
    }
  });
  if (session.lastReviewedHead?.toLowerCase() !== latest.reviewedHead) mismatch.push('Reviewed HEAD differs from the snapshot HEAD');
  if (mismatch.length) return stopped(LEDGER_CODES.HANDOFF_MISMATCH, `Review handoff Seq ${latest.seq} does not match its own record: ${mismatch.join('; ')}.`, mismatch);

  // Cross-check the per-problem records that exist against the snapshot.
  const byId = new Map(session.findings.map((f) => [f.id, f]));
  const recordById = new Map();
  for (const r of findingRecords) {
    if (!byId.has(r.id)) {
      return stopped(LEDGER_CODES.HANDOFF_MISMATCH, `Finding ${r.id} has a record but is missing from the latest handoff.`, [r.id]);
    }
    recordById.set(r.id, r);
  }
  const recordIdsInTable = table.filter((row) => /^\d+$/.test(row.record));
  const knownIds = new Set(records.map((r) => String(r.id)));
  for (const row of recordIdsInTable) {
    if (!knownIds.has(row.record)) {
      return stopped(LEDGER_CODES.HANDOFF_MISMATCH, `The handoff points at the record of ${row.id} (comment ${row.record}) but that comment is gone.`, [row.id]);
    }
  }
  const latestVerdictOf = new Map();
  for (const v of uniqueVerdicts.filter((entry) => entry.order <= latest.lastOrder)) latestVerdictOf.set(v.findingId, v);
  for (const [id, v] of latestVerdictOf) {
    const snap = byId.get(id);
    if (!snap) return stopped(LEDGER_CODES.HANDOFF_MISMATCH, `A verdict exists for ${id} but the latest handoff does not list it.`, [id]);
    if (['FIXED', 'DISMISSED'].includes(v.verdict) && ['OPEN', 'UNCERTAIN'].includes(snap.status)) {
      return stopped(LEDGER_CODES.HANDOFF_MISMATCH, `${id} was recorded ${v.verdict} but the latest handoff shows it ${snap.status}.`, [id]);
    }
  }
  const attempts = attemptsOf(session.findings);
  const attemptsAtHandoff = repairAttempts(session.findings, uniqueVerdicts.filter((entry) => entry.order <= latest.lastOrder));
  const rowAttempts = table.filter((row) => row.attempts !== (attemptsAtHandoff[row.id] ?? 0));
  if (rowAttempts.length) {
    return stopped(LEDGER_CODES.HANDOFF_MISMATCH, `Repair attempt counts in the handoff differ from the verdict records for ${rowAttempts.map((r) => r.id).join(', ')}.`, rowAttempts.map((r) => r.id));
  }

  const stale = headSha && latest.reviewedHead !== String(headSha).toLowerCase();
  // A run that started after the last closed stage and saved its in-progress state: that state is the session now.
  const running = lastRunSnapshot && lastRunSnapshot.order > latest.lastOrder ? snapshotOf(lastRunSnapshot) : null;
  return {
    state: 'ok',
    inProgress: Boolean(running),
    projection,
    session: running ?? session,
    handoff: {
      commentId: latest.commentId, seq: latest.seq, stage: latest.stage, ready: latest.ready, reviewedHead: latest.reviewedHead,
      coverage: latest.coverage, next: latest.next, forCurrentHead: !stale,
    },
    handoffs: handoffs.map((h) => ({ commentId: h.commentId, seq: h.seq, stage: h.stage, reviewedHead: h.reviewedHead })),
    attempts, receipts, runs, verdicts: uniqueVerdicts, conflictingVerdicts: setAside, conflictingHandoffs: setAsideHandoffs,
    findingRecords: findingRecords.map((r) => ({ id: r.id, recordId: r.recordId, source: r.source })),
    events: events.map((e) => ({ findingId: e.findingId, attempt: e.attempt, key: e.key })),
  };
}

// READY <=> the newest handoff says so for the CURRENT head and nothing blocking remains. Never reused for another head.
export function ledgerIsReady(ledger, headSha) {
  if (ledger?.state !== 'ok') return false;
  const { session, handoff } = ledger;
  if (!handoff.ready || handoff.reviewedHead !== String(headSha).toLowerCase() || session.status !== 'READY') return false;
  if (session.coverage && !session.coverage.complete) return false;
  return !session.findings.some((f) => ['OPEN', 'UNCERTAIN'].includes(f.status)
    && (['P0', 'P1', 'P2'].includes(f.severity) || (f.severity === 'P3' && !f.downgradedFrom)));
}
