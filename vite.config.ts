import { visualizer } from 'rollup-plugin-visualizer';
import type { PluginOption } from 'vite';
import { defineConfig, loadEnv, mergeConfig } from 'vite';
import { stripDataTestIdPlugin } from './tooling/vite/plugins/strip-data-testid.ts';
import basePreset from './tooling/vite/presets/base.ts';
import browserAppPreset from './tooling/vite/presets/browser-app.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

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

  const commonPlugins: PluginOption[] = [
    ...(env.VITE_ANALYZE_BUNDLE === 'true'
      ? [
          visualizer({
            filename: 'dist/stats.html',
            gzipSize: true,
            brotliSize: true,
          }) as PluginOption,
        ]
      : []),
    stripDataTestIdPlugin(),
  ];

  const modeConfig = {
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
