// SPDX-License-Identifier: MIT
// Translation completeness verification script
// Parses src/i18n/*.json and verifies all locales have identical keys

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const I18N_DIR = join(ROOT, 'src', 'i18n');
const LOCALES = ['en', 'ko', 'ja', 'zh-CN', 'es', 'ar'] as const;

type LocaleKeyMap = Record<string, Set<string>>;

function getNestedKeys(obj: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>();
  if (typeof obj !== 'object' || obj === null) return keys;

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null) {
      const nested = getNestedKeys(value, fullKey);
      for (const k of nested) keys.add(k);
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

function parseLocale(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf-8');
  const json = JSON.parse(content);
  return getNestedKeys(json);
}

function main(): void {
  console.log('═══ wasm-motion-converter i18n Verification ═══\n');

  const localeKeys: LocaleKeyMap = {};
  const dirEntries = readdirSync(I18N_DIR).filter((f) => f.endsWith('.json'));

  for (const locale of LOCALES) {
    const fileName = `${locale}.json`;
    const filePath = join(I18N_DIR, fileName);

    if (!dirEntries.includes(fileName)) {
      console.error(`❌ Missing locale file: ${fileName}`);
      continue;
    }

    localeKeys[locale] = parseLocale(filePath);
    console.log(`  ${locale}: ${localeKeys[locale].size} keys`);
  }

  // Use en as reference
  const reference = localeKeys.en;
  if (!reference) {
    console.error('\n❌ Reference locale (en) not found!');
    process.exit(1);
  }

  console.log(`\n📊 Reference (en): ${reference.size} keys\n`);

  let allMatch = true;
  const allKeys = new Set<string>();

  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    const keys = localeKeys[locale];
    if (!keys) continue;

    const missingInLocale = [...reference].filter((k) => !keys.has(k));
    const extraInLocale = [...keys].filter((k) => !reference.has(k));

    for (const k of reference) allKeys.add(k);
    for (const k of keys) allKeys.add(k);

    if (missingInLocale.length === 0 && extraInLocale.length === 0) {
      console.log(`✅ ${locale}: MATCH (${keys.size} keys)`);
    } else {
      allMatch = false;
      console.log(`❌ ${locale}: MISMATCH`);
      if (missingInLocale.length > 0) {
        console.log(
          `   Missing ${missingInLocale.length} key(s): ${missingInLocale
            .slice(0, 5)
            .map((k) => `"${k}"`)
            .join(', ')}${missingInLocale.length > 5 ? '...' : ''}`
        );
      }
      if (extraInLocale.length > 0) {
        console.log(
          `   Extra ${extraInLocale.length} key(s): ${extraInLocale
            .slice(0, 5)
            .map((k) => `"${k}"`)
            .join(', ')}${extraInLocale.length > 5 ? '...' : ''}`
        );
      }
    }
  }

  console.log(`\n📈 Total unique keys across all locales: ${allKeys.size}`);

  if (allMatch) {
    console.log('\n✅ ALL LOCALES COMPLETE — all 6 locales have identical key sets.\n');
    process.exit(0);
  } else {
    console.log('\n❌ TRANSLATION COMPLETENESS ISSUES DETECTED.\n');
    process.exit(1);
  }
}

main();
