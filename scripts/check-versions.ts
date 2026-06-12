import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const version = pkg.version as string;

// Validate semver-like format
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`✗ package.json version "${version}" is not valid semver`);
  process.exit(1);
}

// Check that vite.config.ts references package.json version for __VERSION__
const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf-8');
if (!viteConfig.includes('__VERSION__')) {
  console.error('✗ vite.config.ts does not define __VERSION__');
  process.exit(1);
}

// Check that env.d.ts declares __VERSION__
const envDts = 'src/vite-env.d.ts';
try {
  const envContent = readFileSync(resolve(process.cwd(), envDts), 'utf-8');
  if (!envContent.includes('__VERSION__')) {
    console.error(`✗ ${envDts} does not declare __VERSION__`);
    process.exit(1);
  }
} catch {
  console.error(`✗ ${envDts} not found`);
  process.exit(1);
}

console.log(`✓ Version ${version} — all checks pass`);
