import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const pinnedMetadata = resolve(root, 'scripts/ci/pinned-tools.json');
const providerFixtures = resolve(root, 'test/fixtures/scanner-provider');
const providerFiles = [
  [
    'automation/actions/prepare-scanner-pins/action.yaml',
    'action.yaml.txt',
    'f37c9657f724fcc4b39cc28294618ac0ef09d949d94aa2e757507e1f830d2adf',
  ],
  [
    'automation/actions/prepare-scanner-pins/prepare.ts',
    'prepare.ts.txt',
    '0bb6ec52113c17e4cebe86e3da792a8b59c6125cc85cfda4d037741ce7dc812b',
  ],
  [
    'automation/security/scanner-pins.ts',
    'scanner-pins.ts.txt',
    '4975feec038d3969dc38fcd1de73afba04cb84e8cd8e176de9ed8a4a81f7b7a9',
  ],
] as const;
const roots: string[] = [];

type Pins = {
  osv: { version: string; image: string };
  semgrep: { version: string; image: string };
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wmc scanner consumer '));
  roots.push(directory);
  const providerRoot = join(directory, 'reviewed provider');
  const trustedCheckout = join(directory, 'reviewed consumer');
  const candidateCheckout = join(directory, 'candidate checkout');
  const runner = join(directory, 'runner temp');
  const bin = join(directory, 'bin');
  for (const path of [trustedCheckout, candidateCheckout, runner, bin]) mkdirSync(path);
  for (const [relative, fixtureName] of providerFiles) {
    const target = join(providerRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(providerFixtures, fixtureName), target);
  }
  const trustedJson = join(trustedCheckout, 'scripts/ci/pinned-tools.json');
  mkdirSync(dirname(trustedJson), { recursive: true });
  copyFileSync(pinnedMetadata, trustedJson);
  const candidateJson = join(candidateCheckout, 'scripts/ci/pinned-tools.json');
  mkdirSync(dirname(candidateJson), { recursive: true });
  writeFileSync(candidateJson, '{}');
  const pins = JSON.parse(readFileSync(trustedJson, 'utf8')) as Pins;
  const mock = join(bin, 'mock');
  writeFileSync(
    mock,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const file = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.MOCK_SCENARIO || '';
const now = Number(process.env.FIXED_NOW) || Date.now();
const pins = JSON.parse(fs.readFileSync(process.env.TRUSTED_PIN_JSON, 'utf8'));
fs.appendFileSync(process.env.CALLS, JSON.stringify({file, args}) + '\\n');
if (file === 'gh') {
  if (scenario === 'api-fail' && args[1].includes('google/osv-scanner')) process.exit(7);
  const version = args[1].includes('google/osv-scanner') ? pins.osv.version : pins.semgrep.version;
  const young = new Date(now - 3600000).toISOString();
  const old = new Date(now - (scenario === 'boundary' ? 24 : scenario === 'inside-window' ? 23 : 48) * 3600000).toISOString();
  const releases = scenario === 'no-mature' ? [{tag_name:'v' + version,published_at:young,draft:false,prerelease:false}] :
    scenario === 'young-first' ? [
      {tag_name:'v9.9.9',published_at:young,draft:false,prerelease:false},
      {tag_name:'v' + version,published_at:old,draft:false,prerelease:false},
    ] : [{tag_name:'v' + (scenario === 'update' ? '9.9.9' : version),published_at:old,draft:false,prerelease:false}];
  process.stdout.write(JSON.stringify(scenario === 'malformed-api' ? {} : releases));
} else if (file === 'curl') {
  if (args.some((arg) => arg.includes('ghcr.io/token'))) {
    process.stdout.write(JSON.stringify({token:'fixture-bearer-token'}));
  } else {
    if (scenario === 'manifest-fail') {
      process.stderr.write('fixture-bearer-token must not reach workflow diagnostics\\n');
      process.exit(7);
    }
    const digest = pins.osv.image.split('@')[1];
    process.stdout.write(scenario === 'missing-digest' ? 'HTTP/2 200\\r\\n' :
      'Docker-Content-Digest: ' + (scenario === 'mismatch-digest' ? 'sha256:' + '0'.repeat(64) : digest) + '\\r\\n');
  }
}
`
  );
  chmodSync(mock, 0o755);
  for (const name of ['gh', 'curl']) copyFileSync(mock, join(bin, name));
  const output = join(directory, 'github output');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RUNNER_TEMP: runner,
    GITHUB_OUTPUT: output,
    GITHUB_ENV: join(directory, 'github env'),
    GH_TOKEN: 'fixture-gh-token',
    TRUSTED_PIN_JSON: trustedJson,
    CALLS: join(directory, 'calls.jsonl'),
  };
  const prepare = (options: { env?: Record<string, string>; entry?: string } = {}) =>
    spawnSync(
      process.execPath,
      ['--experimental-strip-types', options.entry ?? join(providerRoot, providerFiles[1][0])],
      { cwd: candidateCheckout, env: { ...env, ...options.env }, encoding: 'utf8' }
    );
  const helperPath = () => {
    const value = readFileSync(output, 'utf8');
    expect(value.match(/^helper-path=/gm)).toHaveLength(1);
    return value.slice('helper-path='.length).trimEnd();
  };
  const copyMetadata = () => {
    const directory = mkdtempSync(join(runner, 'pinned-tools.'));
    const snapshot = join(directory, 'pinned-tools.json');
    copyFileSync(trustedJson, snapshot);
    chmodSync(snapshot, 0o600);
    return snapshot;
  };
  const run = (helper: string, mode: 'env' | 'check', snapshot: string, scenario = '') => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', helper, mode, snapshot],
      { cwd: candidateCheckout, env: { ...env, MOCK_SCENARIO: scenario }, encoding: 'utf8' }
    );
    const calls = existsSync(env.CALLS)
      ? readFileSync(env.CALLS, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { file: string; args: string[] })
      : [];
    return { result, calls };
  };
  return {
    directory,
    providerRoot,
    candidateCheckout,
    trustedJson,
    candidateJson,
    runner,
    pins,
    env,
    prepare,
    helperPath,
    copyMetadata,
    run,
  };
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('reviewed scanner provider in the WMC workflow boundary', () => {
  it('binds immutable provider fixture bytes and prepares only the private helper', () => {
    for (const [, name, expected] of providerFiles) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(providerFixtures, name)))
          .digest('hex')
      ).toBe(expected);
    }
    const action = readFileSync(join(providerFixtures, 'action.yaml.txt'), 'utf8');
    expect(action).toContain('run: node "$GITHUB_ACTION_PATH/prepare.ts"');
    expect(action).toContain('value: ${{ steps.prepare.outputs.helper-path }}');
    const f = fixture();
    const prepared = f.prepare();
    expect(prepared.status, prepared.stderr).toBe(0);
    const helper = f.helperPath();
    expect(dirname(helper).startsWith(`${f.runner}/scanner-pin-helper-`)).toBe(true);
    expect(readdirSync(dirname(helper))).toEqual(['scanner-pins.ts']);
    expect(readFileSync(helper)).toEqual(
      readFileSync(join(providerFixtures, 'scanner-pins.ts.txt'))
    );
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(helper)).mode & 0o777).toBe(0o700);
      expect(lstatSync(helper).mode & 0o777).toBe(0o600);
    }
  });

  it('executes both modes with explicit reviewed metadata from an unrelated checkout', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const snapshot = f.copyMetadata();
    expect(readFileSync(snapshot)).toEqual(readFileSync(f.trustedJson));
    expect(readFileSync(f.candidateJson, 'utf8')).toBe('{}');
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(snapshot)).mode & 0o777).toBe(0o700);
      expect(lstatSync(snapshot).mode & 0o777).toBe(0o600);
    }
    const exported = f.run(f.helperPath(), 'env', snapshot);
    expect(exported.result.status, exported.result.stderr).toBe(0);
    expect(exported.calls).toEqual([]);
    expect(readFileSync(f.env.GITHUB_ENV, 'utf8')).toBe(
      `OSV_SCANNER_IMAGE=${f.pins.osv.image}\nSEMGREP_IMAGE=${f.pins.semgrep.image}\n`
    );
    const checked = f.run(f.helperPath(), 'check', snapshot, 'young-first');
    expect(checked.result.status, checked.result.stderr).toBe(0);
    expect(checked.calls.map((call) => call.file)).toEqual(['gh', 'curl', 'curl', 'gh']);
    expect(checked.calls[0]!.args).toContain('repos/google/osv-scanner/releases?per_page=100');
    expect(checked.calls[3]!.args).toContain('repos/semgrep/semgrep/releases?per_page=100');
  });

  it('rejects bad metadata, absent preparation and digest failures', () => {
    const f = fixture();
    const snapshot = f.copyMetadata();
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    const absent = f.run(join(f.runner, 'absent.ts'), 'env', snapshot);
    expect(absent.result.status).toBe(1);
    expect(f.prepare().status).toBe(0);
    const helper = f.helperPath();
    writeFileSync(snapshot, '{');
    expect(f.run(helper, 'env', snapshot).result.status).toBe(1);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    writeFileSync(
      snapshot,
      JSON.stringify({ ...f.pins, semgrep: { ...f.pins.semgrep, version: '9.9.9' } })
    );
    expect(f.run(helper, 'env', snapshot).result.status).toBe(1);
    writeFileSync(
      snapshot,
      JSON.stringify({
        ...f.pins,
        osv: { ...f.pins.osv, image: `${f.pins.osv.image}\nINJECTED=1` },
      })
    );
    expect(f.run(helper, 'env', snapshot).result.status).toBe(1);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
    copyFileSync(f.trustedJson, snapshot);
    expect(f.run(helper, 'check', snapshot, 'mismatch-digest').result.status).toBe(1);
    expect(f.run(helper, 'check', snapshot, 'missing-digest').result.status).toBe(1);
  });

  it('keeps later checks after an earlier failure and scrubs command tokens', () => {
    const failed = fixture();
    expect(failed.prepare().status).toBe(0);
    const snapshot = failed.copyMetadata();
    const response = failed.run(failed.helperPath(), 'check', snapshot, 'api-fail');
    expect(response.result.status).toBe(1);
    expect(response.calls.at(-1)?.args).toContain('repos/semgrep/semgrep/releases?per_page=100');
    const token = fixture();
    expect(token.prepare().status).toBe(0);
    const error = token.run(token.helperPath(), 'check', token.copyMetadata(), 'manifest-fail');
    expect(error.result.status).toBe(1);
    expect(error.result.stderr).toContain('curl request failed (exit 7)');
    expect(error.result.stderr).not.toContain('fixture-bearer-token');
  });

  it('accepts a stable release exactly at the cooling boundary', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const helper = f.helperPath();
    const snapshot = f.copyMetadata();
    const now = Date.parse('2026-10-17T12:00:00Z');
    const runAt = (scenario: string) =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          `import { main } from ${JSON.stringify(pathToFileURL(helper).href)}; process.exitCode = main(['check', ${JSON.stringify(snapshot)}], ${now});`,
        ],
        {
          cwd: f.candidateCheckout,
          env: { ...f.env, MOCK_SCENARIO: scenario, FIXED_NOW: String(now) },
          encoding: 'utf8',
        }
      );
    const boundary = runAt('boundary');
    expect(boundary.status, boundary.stderr).toBe(0);
    expect(boundary.stdout).toContain(`osv-scanner ${f.pins.osv.version} is current`);
    const younger = runAt('inside-window');
    expect(younger.status).toBe(1);
    expect(younger.stderr).toContain('No stable');
  });

  it('refuses a provider symlink and leaves no partial prepared helper', () => {
    const f = fixture();
    const source = join(f.providerRoot, providerFiles[2][0]);
    rmSync(source);
    symlinkSync(f.candidateJson, source);
    const result = f.prepare();
    expect(result.status).toBe(1);
    expect(readdirSync(f.runner)).toEqual([]);
    expect(existsSync(f.env.GITHUB_OUTPUT)).toBe(false);
  });

  it('imports the copied provider without reading metadata or running commands', () => {
    const f = fixture();
    expect(f.prepare().status).toBe(0);
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(f.helperPath()).href)})`,
      ],
      { cwd: f.candidateCheckout, env: f.env, encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.env.CALLS)).toBe(false);
    expect(existsSync(f.env.GITHUB_ENV)).toBe(false);
  });
});
