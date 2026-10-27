/** Pages source builds use the same Vite+ build lifecycle as local builds. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

type Execute = (command: string, args: string[], environment?: NodeJS.ProcessEnv) => string;

function execute(command: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.stdout && command !== 'curl') process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return command === 'curl' ? result.stdout : result.stdout.trim();
}

export function installPagesVitePlus(
  installer: string,
  home: string,
  nodePin: string,
  vitePin: string,
  run: Execute,
  profileDirectory = homedir()
): void {
  const profiles = ['.bashrc', '.profile'].map((name) => {
    const path = join(profileDirectory, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !stat.isFile())
      throw new Error(`Pages installer profile is not a regular file: ${path}`);
    return { path, before: stat ? readFileSync(path) : undefined };
  });
  let primaryFailure: unknown;
  try {
    run('bash', [installer], {
      VP_HOME: home,
      VP_VERSION: vitePin,
      VP_SETUP_NODE_VERSION: nodePin,
      VP_NODE_MANAGER: 'yes',
      CI: '1',
    });
  } catch (error) {
    primaryFailure = error;
  }
  const suffix = Buffer.from(`\n# Vite+ bin (https://viteplus.dev)\n. "${home}/env"\n`);
  for (const { path, before } of profiles) {
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) {
        if (before !== undefined) throw new Error(`Installer removed profile: ${path}`);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Installer changed profile file type: ${path}`);
      const after = readFileSync(path);
      if (before?.equals(after)) continue;
      const expected = before ? Buffer.concat([before, suffix]) : suffix;
      if (!after.equals(expected))
        throw new Error(`Installer changed profile outside its exact Vite+ suffix: ${path}`);
      if (before) writeFileSync(path, before);
      else rmSync(path);
    } catch (error) {
      if (primaryFailure === undefined) primaryFailure = error;
      else console.error('Failed to restore installer-owned profile suffix:', error);
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
}

export function pagesBuild(root: string, run: Execute = execute): void {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const pnpmPin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  const nodeFile = join(root, '.node-version');
  if (!lstatSync(nodeFile).isFile()) throw new Error('Pages requires a regular .node-version');
  const nodePin = readFileSync(nodeFile, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/u.test(nodePin) || !pnpmPin)
    throw new Error('Pages toolchain pins must be exact');
  if (process.versions.node !== nodePin)
    throw new Error('Pages Node version does not match .node-version');

  // The Pages image supplies Node before this command. Install the reviewed
  // global Vite+ CLI when absent; the project catalog remains its version authority.
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const catalog = workspace.split(/^catalog:\s*$/mu)[1]?.split(/^[^\s#]/mu)[0] ?? '';
  const vitePin = /^  vite-plus: (\d+\.\d+\.\d+)$/mu.exec(catalog)?.[1];
  if (!vitePin) throw new Error('Pages requires an exact Vite+ catalog pin');
  let vpVersion: string | undefined;
  try {
    vpVersion = run('vp', ['--version']);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    // No Vite+ CLI on the provider image.
  }
  if (vpVersion === undefined) {
    const temporary = mkdtempSync(join(tmpdir(), 'wmc-pages-vp-'));
    let installerStarted = false;
    let completed = false;
    try {
      const installer = join(temporary, 'install.sh');
      const source = run('curl', [
        '-fsSL',
        'https://raw.githubusercontent.com/voidzero-dev/vite-plus/102fe8edad2c45690f24830feee30bfe242817ee/packages/cli/install.sh',
      ]);
      if (
        createHash('sha256').update(source).digest('hex') !==
        '6eaf139e16d45849bebc4a7de0dbc2992fd3b3a86a3f37bf7922b685f3a60d9e'
      )
        throw new Error('Pages Vite+ installer digest mismatch');
      writeFileSync(installer, source);
      const home = join(temporary, 'home');
      installerStarted = true;
      installPagesVitePlus(installer, home, nodePin, vitePin, run);
      const vp = join(home, 'bin', 'vp');
      const isolatedEnvironment = { VP_HOME: home };
      vpVersion = run(vp, ['--version'], isolatedEnvironment);
      if (vpVersion.split('\n')[0] !== `vp v${vitePin}`)
        throw new Error('Pages Vite+ version mismatch');
      pagesBuildWithVp(root, vp, isolatedEnvironment, run, nodePin, pnpmPin);
      completed = true;
    } finally {
      if (completed || !installerStarted) rmSync(temporary, { recursive: true, force: true });
      else console.error(`[pages] Preserved failed Vite+ bootstrap at ${temporary}`);
    }
    return;
  }
  if (vpVersion.split('\n')[0] !== `vp v${vitePin}`)
    throw new Error('Pages Vite+ version mismatch');
  pagesBuildWithVp(root, 'vp', {}, run, nodePin, pnpmPin);
}

function pagesBuildWithVp(
  root: string,
  vp: string,
  environment: NodeJS.ProcessEnv,
  run: Execute,
  nodePin: string,
  pnpmPin: string
): void {
  const selected = JSON.parse(run(vp, ['env', 'current', '--json'], environment)) as {
    node?: { version?: string };
    package_manager?: { name?: string; version?: string };
  };
  if (
    selected.node?.version !== nodePin ||
    selected.package_manager?.name !== 'pnpm' ||
    selected.package_manager.version !== pnpmPin
  )
    throw new Error('Pages Vite+ environment differs from project pins');
  // Qualify the selected native manager before admitting project dependencies.
  run(vp, ['env', 'install', 'pnpm'], environment);
  if (process.env.CF_PAGES === '1' && process.env.PAGES_NODE_QUALIFICATION === '1') {
    run(
      process.execPath,
      ['--experimental-strip-types', join(root, 'scripts/build/qualify-pages-runtime.ts')],
      { ...environment, PAGES_VP_BINARY: vp }
    );
  }
  console.log(
    `[pages] Node ${process.versions.node}; executable ${process.execPath}; Vite+ ${run(vp, ['--version'], environment).split('\n')[0]}; pnpm ${pnpmPin}`
  );
  run('git', ['submodule', 'sync', '--recursive']);
  run('git', ['submodule', 'update', '--init', '--recursive']);
  const expectedCore = run('git', ['rev-parse', 'HEAD:packages/core']);
  if (run('git', ['-C', 'packages/core', 'rev-parse', 'HEAD']) !== expectedCore)
    throw new Error('Pages core gitlink mismatch');
  console.log(`[pages] Core ${expectedCore}`);
  run(vp, ['install', '--frozen-lockfile', '--', '--no-runtime'], {
    ...environment,
    NODE_ENV: 'development',
  });
  // Separate GitHub CI is not an exact-source deployment prerequisite. Preserve
  // prebuild quality/licenses and postbuild inventory/reference validation here.
  run(vp, ['run', 'build'], { ...environment, NODE_ENV: 'production' });
}

if (import.meta.main) {
  try {
    pagesBuild(process.cwd());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
