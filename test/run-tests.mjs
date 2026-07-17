#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// CLI test runner for conversion tests.
// Usage:
//   node test/run-tests.js                  # Run all tests
//   node test/run-tests.js --codec h264     # Run H.264 tests only
//   node test/run-tests.js --format gif     # Run GIF tests only
//   node test/run-tests.js --smoke          # Run smoke tests (1 case)
//   node test/run-tests.js --report         # Generate result report
//   node test/run-tests.js --regressions    # Check for regressions

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

// Parse flags
const flags = {
  codec: null as string | null,
  format: null as string | null,
  quality: null as string | null,
  smoke: false,
  report: false,
  regressions: false,
  list: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--codec' && args[i + 1]) flags.codec = args[++i]!;
  else if (arg === '--format' && args[i + 1]) flags.format = args[++i]!;
  else if (arg === '--quality' && args[i + 1]) flags.quality = args[++i]!;
  else if (arg === '--smoke') flags.smoke = true;
  else if (arg === '--report') flags.report = true;
  else if (arg === '--regressions') flags.regressions = true;
  else if (arg === '--list') flags.list = true;
}

// Handle report generation
if (flags.report) {
  const { generateReport } = await import('./lib/test-recorder');
  const report = generateReport();
  console.log(report);

  // Save report
  const reportDir = join(import.meta.dirname, '..', '.results');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportFile = join(reportDir, `report-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(reportFile, report, 'utf-8');
  console.log(`\nReport saved to: ${reportFile}`);
  process.exit(0);
}

// Handle regression check
if (flags.regressions) {
  const { detectRegressions } = await import('./lib/test-recorder');
  const regressions = detectRegressions();
  if (regressions.length === 0) {
    console.log('No regressions detected.');
    process.exit(0);
  } else {
    console.log(`\n${regressions.length} regression(s) detected:\n`);
    for (const r of regressions) {
      console.log(`  [${r.type.toUpperCase()}] ${r.videoId} → ${r.format} (${r.quality}, ${r.scale})`);
      console.log(`    ${r.message}`);
    }
    process.exit(1);
  }
}

// Handle list mode
if (flags.list) {
  const { generateTestMatrix, formatDuration } = await import('./lib/test-matrix');
  const cases = generateTestMatrix();
  console.log(`\nTest Matrix (${cases.length} cases):\n`);
  for (const c of cases) {
    console.log(`  ${c.name}`);
  }
  console.log(`\nFilters: --codec <name> --format <gif|webp> --quality <low|medium|high>`);
  process.exit(0);
}

// Build Playwright filter
const filters: string[] = [];
if (flags.smoke) {
  filters.push('smoke');
} else {
  // Build test name filter from flags
  if (flags.codec) filters.push(flags.codec);
  if (flags.format) filters.push(`→ ${flags.format.toUpperCase()}`);
}

const filterStr = filters.length > 0 ? `--grep "${filters.join(' ')}"` : '';

// Run Playwright
const cmd = `cd ${join(import.meta.dirname, '..')} && npx playwright test test/e2e/conversion-matrix.spec.ts ${filterStr} --reporter=list 2>&1`;

console.log(`\nRunning: ${cmd}\n`);
try {
  execSync(cmd, { stdio: 'inherit' });
} catch (e) {
  process.exit(1);
}
