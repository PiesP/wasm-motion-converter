#!/usr/bin/env node
/** Classify workflow changes. Unknown inputs conservatively enable every gate. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { argv, env, exit, stdin } from 'node:process';
import { fileURLToPath } from 'node:url';

const keys = [
  'all',
  'quality',
  'unit',
  'e2e',
  'build',
  'duplication',
  'mutation',
  'dependency',
  'codeql',
  'semgrep',
  'semgrep_full',
  'security_tools',
] as const;
type Gate = (typeof keys)[number];
type Routes = Record<Gate, boolean>;

function emptyRoutes(): Routes {
  return Object.fromEntries(keys.map((key) => [key, false])) as Routes;
}

function enable(routes: Routes, ...gates: Gate[]): void {
  for (const gate of gates) routes[gate] = true;
}

function enableAll(routes: Routes): void {
  for (const gate of keys) routes[gate] = true;
}

function classifyPath(routes: Routes, path: string): void {
  if (path === 'scripts/ci/classify-workflow-changes.ts' || path === '.github/workflows/ci.yaml') {
    enableAll(routes);
  } else if (
    [
      'README.md',
      'CHANGELOG.md',
      'CODE_OF_CONDUCT.md',
      'CONTRIBUTING.md',
      'SUPPORT.md',
      'LICENSE',
      'test/README.md',
      '.github/pull_request_template.md',
    ].includes(path) ||
    path.startsWith('docs/') ||
    path.startsWith('.github/ISSUE_TEMPLATE/')
  ) {
    enable(routes, 'semgrep');
  } else if (path.startsWith('test/__screenshots__/')) {
    // Binary visual baselines are outside the CI browser profile.
  } else if (path === '.gitmodules' || path === 'packages/core') {
    enable(
      routes,
      'quality',
      'unit',
      'e2e',
      'build',
      'mutation',
      'dependency',
      'codeql',
      'semgrep',
      'semgrep_full'
    );
  } else if (
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version'].includes(path)
  ) {
    enable(
      routes,
      'quality',
      'unit',
      'e2e',
      'build',
      'mutation',
      'dependency',
      'codeql',
      'semgrep',
      'semgrep_full',
      'security_tools'
    );
  } else if (path.startsWith('src/')) {
    enable(
      routes,
      'quality',
      'unit',
      'e2e',
      'build',
      'duplication',
      'mutation',
      'codeql',
      'semgrep',
      'semgrep_full'
    );
  } else if (path.startsWith('functions/') || path.startsWith('tooling/')) {
    enable(routes, 'quality', 'unit', 'e2e', 'build', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path.startsWith('public/') || path === 'index.html') {
    enable(routes, 'quality', 'unit', 'e2e', 'build', 'codeql', 'semgrep', 'semgrep_full');
  } else if (
    path.startsWith('test/unit/') ||
    path === 'test/setup.ts' ||
    path === 'vitest.config.ts' ||
    path === 'tsconfig.test.json'
  ) {
    enable(routes, 'quality', 'unit', 'mutation', 'codeql', 'semgrep', 'semgrep_full');
  } else if (
    path.startsWith('test/e2e/') ||
    path.startsWith('test/lib/') ||
    path === 'test/tsconfig.playwright.json' ||
    path === 'playwright.config.ts'
  ) {
    enable(routes, 'quality', 'e2e', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path.startsWith('scripts/test/')) {
    enable(routes, 'quality', 'unit', 'e2e', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path.startsWith('scripts/build/') || path.startsWith('scripts/release/')) {
    enable(routes, 'quality', 'unit', 'build', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path.startsWith('scripts/ci/')) {
    enable(
      routes,
      'quality',
      'unit',
      'duplication',
      'codeql',
      'semgrep',
      'semgrep_full',
      'security_tools'
    );
  } else if (path.startsWith('scripts/security/')) {
    if (path === 'scripts/security/validate-osv-results.py') enable(routes, 'dependency');
    enable(routes, 'quality', 'unit', 'codeql', 'semgrep', 'semgrep_full', 'security_tools');
  } else if (path === '.github/workflows/security.yaml') {
    enable(routes, 'unit', 'dependency', 'codeql', 'semgrep', 'semgrep_full', 'security_tools');
  } else if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
    enable(routes, 'unit', 'codeql', 'semgrep', 'semgrep_full', 'security_tools');
  } else if (
    ['.github/threat-model.md', '.github/SECURITY.md', '.github/dependabot.yaml'].includes(path)
  ) {
    enable(routes, 'unit', 'dependency', 'codeql', 'semgrep', 'semgrep_full', 'security_tools');
  } else if (['biome.json', 'knip.json', 'tsconfig.json'].includes(path)) {
    enable(routes, 'quality', 'unit', 'build', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path === 'vite.config.ts') {
    enable(routes, 'quality', 'unit', 'e2e', 'build', 'codeql', 'semgrep', 'semgrep_full');
  } else if (['stryker.conf.json', 'stryker.conf.fast.json'].includes(path)) {
    enable(routes, 'quality', 'unit', 'mutation', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path === '.nose-baseline.json' || path === 'nose.toml') {
    enable(routes, 'quality', 'unit', 'duplication', 'semgrep', 'semgrep_full');
  } else if (path === 'wrangler.toml') {
    enable(routes, 'unit', 'codeql', 'semgrep', 'semgrep_full');
  } else if (path === '.gitattributes' || path === '.gitignore') {
    enable(routes, 'semgrep');
  } else if (path.startsWith('.githooks/')) {
    enable(routes, 'quality', 'unit', 'codeql', 'semgrep', 'semgrep_full');
  } else {
    console.error(`Unknown changed path; enabling all checks: ${path}`);
    enableAll(routes);
  }
}

function nestedString(value: unknown, ...fields: string[]): string | undefined {
  let current = value;
  for (const field of fields) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[field];
  }
  return typeof current === 'string' ? current : undefined;
}

function changedPathsForEvent(routes: Routes): string[] {
  const eventName = env.GITHUB_EVENT_NAME ?? 'unknown';
  if (['workflow_dispatch', 'schedule', 'repository_dispatch'].includes(eventName)) {
    enableAll(routes);
    return [];
  }
  if (!['pull_request', 'push', 'merge_group'].includes(eventName)) {
    console.error(`Unsupported GitHub event; enabling all checks: ${eventName}`);
    enableAll(routes);
    return [];
  }
  let event: unknown;
  try {
    if (!env.GITHUB_EVENT_PATH) throw new Error('missing event path');
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as unknown;
  } catch {
    console.error('GitHub event payload is unavailable; enabling all checks.');
    enableAll(routes);
    return [];
  }
  const base =
    eventName === 'pull_request'
      ? nestedString(event, 'pull_request', 'base', 'sha')
      : eventName === 'push'
        ? nestedString(event, 'before')
        : nestedString(event, 'merge_group', 'base_sha');
  const head =
    eventName === 'pull_request'
      ? env.GITHUB_SHA
      : eventName === 'push'
        ? nestedString(event, 'after')
        : nestedString(event, 'merge_group', 'head_sha');
  if (
    !base ||
    !head ||
    !/^[0-9a-f]{40}$/.test(base) ||
    !/^[0-9a-f]{40}$/.test(head) ||
    /^0+$/.test(base)
  ) {
    console.error('GitHub diff boundary is invalid; enabling all checks.');
    enableAll(routes);
    return [];
  }
  try {
    const result = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths = result.toString('utf8').split('\0');
    if (paths.at(-1) === '') paths.pop();
    if (paths.length === 0) {
      console.error('GitHub diff is empty; enabling all checks.');
      enableAll(routes);
    }
    return paths;
  } catch {
    console.error('Unable to calculate GitHub diff; enabling all checks.');
    enableAll(routes);
    return [];
  }
}

function classify(mode: string): Routes {
  const routes = emptyRoutes();
  let paths: string[] = [];
  if (mode === '--files-from-stdin') {
    const input = readFileSync(stdin.fd, 'utf8');
    paths = input.split('\n');
    if (paths.at(-1) === '') paths.pop();
  } else if (mode === 'event') {
    paths = changedPathsForEvent(routes);
  } else {
    console.error(`Unsupported classifier mode: ${mode}`);
    enableAll(routes);
  }
  if (!routes.all) {
    if (paths.length === 0) {
      console.error('No changed paths supplied; enabling all checks.');
      enableAll(routes);
    } else {
      for (const path of paths) {
        classifyPath(routes, path);
        if (routes.all) break;
      }
    }
  }
  return routes;
}

function main(): void {
  const routes = classify(argv[2] || 'event');
  const lines = `${keys.map((key) => `${key}=${routes[key]}`).join('\n')}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

function isDirectInvocation(): boolean {
  if (!argv[1]) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    console.error(error);
    exit(1);
  }
}
