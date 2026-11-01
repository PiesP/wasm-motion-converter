import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../..');
const definition = resolve(root, 'scripts/build/node-build-definitions/26.13.0');

function runDefinition(os: string, arch: string, options: Record<string, string | undefined> = {}) {
  return spawnSync(
    'bash',
    [
      '-c',
      `uname() {
        case "$1" in
          -s) printf '%s\\n' "$TEST_OS" ;;
          -m) printf '%s\\n' "$TEST_ARCH" ;;
          *) return 1 ;;
        esac
      }
      if [ "$TEST_HASHER_MODE" != missing ]; then
        compute_sha2() {
          case "$TEST_HASHER_MODE" in
            real) sha256sum | cut -d ' ' -f 1 ;;
            failing) printf '%s\\n' 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08; return 1 ;;
            wrong) printf '%064d\\n' 0 ;;
          esac
        }
      fi
      install_package() { printf '%s\\n' "$@"; }
      . "$TEST_DEFINITION"`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_OS: os,
        TEST_ARCH: arch,
        TEST_DEFINITION: definition,
        TEST_HASHER_MODE: 'real',
        SKIP_BINARY: undefined,
        ASDF_NODEJS_FORCE_COMPILE: undefined,
        NODE_BUILD_TARBALL_OVERRIDE: undefined,
        ...options,
      },
    }
  );
}

describe('Pages node-build definition', () => {
  it('matches the exact project runtime pin', () => {
    expect(readFileSync(resolve(root, '.node-version'), 'utf8').trim()).toBe('26.13.0');
  });

  it.each(['x86_64', 'amd64'])('installs only the official Linux %s binary', (arch) => {
    const result = runDefinition('Linux', arch);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'node-v26.13.0-linux-x64',
      'https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.gz#5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455',
      'copy',
    ]);
  });

  it.each([
    ['Linux', 'aarch64'],
    ['Darwin', 'x86_64'],
  ])('rejects unsupported %s/%s before installation', (os, arch) => {
    const result = runDefinition(os, arch);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('official Linux x64 binary');
  });

  it.each([
    [{ SKIP_BINARY: 'true' }, 'source compilation'],
    [{ ASDF_NODEJS_FORCE_COMPILE: '1' }, 'source compilation'],
    [{ NODE_BUILD_TARBALL_OVERRIDE: 'https://example.invalid/source.tar.gz' }, 'tarball overrides'],
  ])('rejects installer override %j before installation', (options, error) => {
    const result = runDefinition('Linux', 'x86_64', options);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error);
  });

  it.each(['missing', 'failing', 'wrong'])(
    'rejects a %s SHA-256 implementation before installation',
    (mode) => {
      const result = runDefinition('Linux', 'x86_64', { TEST_HASHER_MODE: mode });

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('working SHA-256 verification');
    }
  );
});
