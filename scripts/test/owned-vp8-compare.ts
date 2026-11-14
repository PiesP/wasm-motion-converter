/** ABI2 tuning entrypoint; #497's original ABI1 command remains at its frozen revision. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compare } from './owned-vp8-v2-compare.ts';

const output = mkdtempSync(join(tmpdir(), 'owned-vp8-tuning-'));
const report = await compare({ output, split: 'tuning', sources: {} });
console.log(JSON.stringify({ evidenceDirectory: output, report }, null, 2));
