/** Pages source builds use the same Vite+ build lifecycle as local builds. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

type Execute = (command: string, args: string[], environment?: NodeJS.ProcessEnv) => string;
type ObservedFile = { bytes: Buffer; dev: bigint; ino: bigint };
const maxProfileBytes = 4 * 1024 * 1024;

function observeOpenFile(fd: number, path: string, limit: number): ObservedFile {
  const first = fstatSync(fd, { bigint: true });
  if (!first.isFile()) throw new Error(`Pages requires a regular file: ${path}`);
  if (first.size > BigInt(limit)) throw new Error(`Pages file exceeds ${limit} bytes: ${path}`);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const count = readSync(fd, chunk, 0, chunk.length, total);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > limit) throw new Error(`Pages file exceeds ${limit} bytes: ${path}`);
  const last = fstatSync(fd, { bigint: true });
  if (
    first.dev !== last.dev ||
    first.ino !== last.ino ||
    first.size !== last.size ||
    first.mtimeNs !== last.mtimeNs ||
    first.ctimeNs !== last.ctimeNs
  )
    throw new Error(`Pages file changed while reading: ${path}`);
  return { bytes: Buffer.concat(chunks), dev: first.dev, ino: first.ino };
}

function observeRegularFile(
  path: string,
  limit: number,
  allowMissing = false
): ObservedFile | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
  try {
    return observeOpenFile(fd, path, limit);
  } finally {
    closeSync(fd);
  }
}

function sameFile(left: ObservedFile, right: ObservedFile): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function restoreProfile(path: string, before: ObservedFile | undefined, suffix: Buffer): void {
  const appendedLimit = maxProfileBytes + suffix.length;
  const after = observeRegularFile(path, appendedLimit, true);
  if (!after) {
    if (before) throw new Error(`Installer removed profile: ${path}`);
    return;
  }
  if (before && !sameFile(before, after)) throw new Error(`Installer replaced profile: ${path}`);
  if (before?.bytes.equals(after.bytes)) return;
  const expected = before ? Buffer.concat([before.bytes, suffix]) : suffix;
  if (!after.bytes.equals(expected))
    throw new Error(`Installer changed profile outside its exact Vite+ suffix: ${path}`);
  if (before) {
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = observeOpenFile(fd, path, appendedLimit);
      if (!sameFile(before, current) || !current.bytes.equals(expected))
        throw new Error(`Installer changed profile before suffix removal: ${path}`);
      ftruncateSync(fd, before.bytes.length);
    } finally {
      closeSync(fd);
    }
    return;
  }
  // A profile created by the installer is removed only after moving it to a
  // private name and confirming that the moved inode still has the exact suffix.
  const quarantine = `${path}.vite-plus-restore-${randomUUID()}`;
  renameSync(path, quarantine);
  try {
    const moved = observeRegularFile(quarantine, appendedLimit);
    if (!moved || !sameFile(after, moved) || !moved.bytes.equals(suffix))
      throw new Error(`Installer-created profile changed before removal: ${path}`);
    unlinkSync(quarantine);
  } catch (error) {
    try {
      linkSync(quarantine, path);
      unlinkSync(quarantine);
    } catch (restoreError) {
      console.error(`Preserved changed installer profile at ${quarantine}:`, restoreError);
    }
    throw error;
  }
}

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
    return { path, before: observeRegularFile(path, maxProfileBytes, true) };
  });
  let primaryFailure: unknown;
  try {
    run('bash', [installer], {
      VP_HOME: home,
      VP_VERSION: vitePin,
      VP_SETUP_NODE_VERSION: nodePin,
      VP_NODE_MANAGER: 'yes',
      VP_PM_MANAGER: 'yes',
      CI: '1',
    });
  } catch (error) {
    primaryFailure = error;
  }
  const suffix = Buffer.from(`\n# Vite+ bin (https://viteplus.dev)\n. "${home}/env"\n`);
  for (const { path, before } of profiles) {
    try {
      restoreProfile(path, before, suffix);
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
  const nodeFileState = observeRegularFile(nodeFile, 64);
  if (!nodeFileState) throw new Error('Pages requires a regular .node-version');
  const nodePin = nodeFileState.bytes.toString('utf8').trim();
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
