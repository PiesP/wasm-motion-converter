/**
 * check-i18n: Verify that all JSON locale files have identical key sets.
 * Run via: node --experimental-strip-types scripts/check/i18n.ts
 * Expected: silent exit 0. On mismatch, prints missing/extra keys and exits 1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const i18nDir = resolve(__dirname, '..', '..', 'src', 'i18n');

const files = readdirSync(i18nDir).filter((file) => file.endsWith('.json'));
if (files.length === 0) {
  console.error('No JSON locale files found in src/i18n/');
  process.exit(1);
}

// Load English keys as the reference
const enPath = resolve(i18nDir, 'en.json');
const enKeys = Object.keys(JSON.parse(readFileSync(enPath, 'utf-8')) as Record<string, unknown>);
const enKeySet = new Set(enKeys);

let hasErrors = false;

for (const file of files) {
  if (file === 'en.json') continue;
  const data = JSON.parse(readFileSync(resolve(i18nDir, file), 'utf-8')) as Record<string, unknown>;
  const localeKeys = new Set(Object.keys(data));

  // Check for missing keys (in en but not in this locale)
  const missing = enKeys.filter((k) => !localeKeys.has(k));
  if (missing.length > 0) {
    console.error(`❌ ${file}: missing ${missing.length} keys:`);
    for (const k of missing) console.error(`  - ${k}`);
    hasErrors = true;
  }

  // Check for extra keys (in this locale but not in en)
  const extra = Object.keys(data).filter((k) => !enKeySet.has(k));
  if (extra.length > 0) {
    console.error(`❌ ${file}: ${extra.length} extra keys:`);
    for (const k of extra) console.error(`  - ${k}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
}
console.log(`✅ All ${files.length} locale files have identical key sets (${enKeys.length} keys)`);
