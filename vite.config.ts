import type { PluginOption } from 'vite-plus';
import { defineConfig, mergeConfig } from 'vite-plus';

import { applicationSourceSha } from './scripts/build/deployment-state.ts';
import { emitServiceWorkerPlugin } from './tooling/vite/plugins/emit-service-worker.ts';
import { stripDataTestIdPlugin } from './tooling/vite/plugins/strip-data-testid.ts';
import basePreset from './tooling/vite/presets/base.ts';
import browserAppPreset from './tooling/vite/presets/browser-app.ts';

export default defineConfig(({ command }) => {
  // Solid applies reactive width and position style attributes at runtime, and
  // Vite HMR injects styles in development. Keep preview aligned with the
  // deployed Cloudflare policy in public/_headers.
  // Allow WebAssembly compilation without enabling JavaScript eval()/Function().
  const styleSrc = "'self' 'unsafe-inline'";
  const scriptSrc = "'self' 'wasm-unsafe-eval'";

  const cspHeader = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "connect-src 'self' blob:",
    "worker-src 'self'",
  ].join('; ');

  const commonPlugins: PluginOption[] = [stripDataTestIdPlugin(), emitServiceWorkerPlugin()];

  const modeConfig = {
    run: {
      cache: false,
      tasks: {
        quality: {
          command: [
            'vp run fmt',
            'vp run lint',
            'vp run check',
            'vp run check:test:unit',
            'vp run check:test:e2e',
            'vp run check:scripts',
            'vp run check:windows',
            'vp run check:worker',
            'vp run test:ci',
            'vp run check:i18n',
          ],
          cache: false,
        },
        'build:ci': { command: 'vp run build', cache: false },
        verify: { command: 'vp run build:ci', cache: false },
        'verify:full': {
          command: [
            'vp run verify',
            'vp run test:cov',
            'node --experimental-strip-types scripts/test/run-e2e-on-free-port.ts',
          ],
          cache: false,
        },
      },
    },
    fmt: {
      useTabs: false,
      tabWidth: 2,
      endOfLine: 'lf',
      printWidth: 100,
      singleQuote: true,
      jsxSingleQuote: false,
      quoteProps: 'as-needed',
      trailingComma: 'es5',
      semi: true,
      arrowParens: 'always',
      bracketSameLine: false,
      bracketSpacing: true,
      sortImports: true,
      sortPackageJson: false,
      ignorePatterns: [
        '**/*.md',
        '**/*.yaml',
        '**/*.yml',
        'packages/core/**',
        'validation/windows/inputs/**',
        'validation/windows/prior-dist/**',
        'validation/windows/public-target.json',
      ],
    },
    lint: {
      ignorePatterns: [
        'packages/core/**',
        'validation/windows/inputs/**',
        'validation/windows/prior-dist/**',
        'validation/windows/public-target.json',
      ],
      plugins: ['typescript', 'jsx-a11y', 'oxc', 'unicorn', 'import'],
      jsPlugins: ['vite-plus/oxlint-plugin'],
      options: { typeAware: true, typeCheck: false },
      rules: {
        'vite-plus/prefer-vite-plus-imports': 'error',
        // Preserve deliberate snapshots of mutable queues and acceptance collections.
        'unicorn/no-useless-spread': 'off',
        'eslint/no-control-regex': 'off',
        'eslint/no-unassigned-vars': 'off',
        'eslint/no-unused-expressions': 'off',
        'eslint/no-unsafe-finally': 'off',
        'typescript/no-explicit-any': 'error',
        'typescript/no-unused-vars': 'warn',
        'typescript/no-this-alias': 'off',
        // Existing asynchronous ownership and branded unions are validated by
        // the project's focused tests and four TypeScript projects.
        'typescript/no-floating-promises': 'off',
        'typescript/unbound-method': 'off',
        'typescript/no-redundant-type-constituents': 'off',
        'typescript/no-base-to-string': 'off',
        'typescript/require-array-sort-compare': 'off',
        'typescript/restrict-template-expressions': 'off',
        'typescript/no-useless-default-assignment': 'off',
        'typescript/await-thenable': 'off',
        'oxc/no-accumulating-spread': 'error',
        'eslint/prefer-const': 'error',
        'eslint/prefer-exponentiation-operator': 'error',
        'eslint/no-self-compare': 'warn',
        'eslint/array-callback-return': 'error',
        'eslint/no-unneeded-ternary': 'error',
        'unicorn/no-useless-switch-case': 'error',
        'eslint/no-lone-blocks': 'error',
        'eslint/no-param-reassign': 'warn',
        'jsx-a11y/no-static-element-interactions': 'error',
        'jsx-a11y/click-events-have-key-events': 'error',
        'jsx-a11y/no-noninteractive-element-interactions': 'off',
        'jsx-a11y/prefer-tag-over-role': 'off',
        'jsx-a11y/role-supports-aria-props': 'error',
      },
      overrides: [
        {
          files: ['src/**'],
          rules: {
            'import/no-cycle': ['error', { ignoreTypes: false, ignoreExternal: false }],
            'eslint/no-restricted-imports': [
              'error',
              {
                patterns: [
                  {
                    group: ['../**', 'src/**', '/src/**', './*/**'],
                    message:
                      'Use an alias-based leaf import across folders; same-folder relative imports are allowed.',
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    define: {
      __APP_SOURCE_SHA__: JSON.stringify(
        command === 'build' ? applicationSourceSha(process.cwd()) : null
      ),
    },
    plugins: commonPlugins,
    server: {
      headers: {
        'Content-Security-Policy': cspHeader,
      },
    },
    preview: {
      headers: {
        'Content-Security-Policy': cspHeader,
      },
    },
  };

  return mergeConfig(mergeConfig(basePreset, browserAppPreset), modeConfig);
});
