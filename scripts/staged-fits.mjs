import fs from 'node:fs';
import path from 'node:path';
import { stagedDiffFits } from './review-shards.mjs';

// Exit 0 when the PR diff can be audited in one staged run, 1 when it needs the sharded engine.
const root = path.resolve(process.argv[2] || '.review-context');
const read = (name) => { try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return ''; } };
process.exitCode = stagedDiffFits(read('pr.diff'), read('ignore-patterns.txt')) ? 0 : 1;
