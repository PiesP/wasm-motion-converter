import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const toolchainAction = readFileSync(
  resolve(root, '.github/actions/setup-toolchain/action.yaml'),
  'utf8'
);
const projectAction = readFileSync(resolve(root, '.github/actions/setup-project/action.yaml'), 'utf8');
const workflowFiles = ['ci.yaml', 'deep-checks.yaml', 'release.yaml'];

describe('setup-toolchain action', () => {
  it('uses pnpm/setup with repository pins and dependency caching', () => {
    expect(toolchainAction).toContain(
      'uses: pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2 # v2.0.2'
    );
    expect(toolchainAction).toContain('package-json-file: package.json');
    expect(toolchainAction).toContain('runtime: "node@${{ inputs.node-version }}"');
    expect(toolchainAction).toContain('cache: true');
    expect(toolchainAction).toContain('install: false');
    expect(toolchainAction).not.toContain('self-update');
    expect(
      existsSync(resolve(root, '.github/actions/setup-toolchain/bootstrap-package.json'))
    ).toBe(false);
  });

  it('installs frozen dependencies through the project setup action', () => {
    expect(projectAction).toContain('uses: ./.github/actions/setup-toolchain');
    expect(projectAction).toContain('node-version: ${{ inputs.node-version }}');
    expect(projectAction).toContain('run: pnpm install --frozen-lockfile');
  });

  it('keeps normal Node and pnpm workflow setup behind the local project action', () => {
    for (const filename of workflowFiles) {
      const workflow = readFileSync(
        resolve(root, '.github/workflows', filename),
        'utf8'
      );

      expect(workflow).toContain('uses: ./.github/actions/setup-project');
      expect(workflow).toContain('node-version: ${{ env.NODE_VERSION }}');
      expect(workflow).not.toContain('uses: ./.github/actions/setup-toolchain');
      expect(workflow).not.toContain('run: pnpm install --frozen-lockfile');
      expect(workflow).not.toContain('uses: pnpm/action-setup@');
      expect(workflow).not.toContain('uses: actions/setup-node@');
    }
  });
});
