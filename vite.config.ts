import { visualizer } from 'rollup-plugin-visualizer';
import type { PluginOption } from 'vite';
import { defineConfig, loadEnv, mergeConfig } from 'vite';
import { stripDataTestIdPlugin } from './tooling/vite/plugins/strip-data-testid';
import basePreset from './tooling/vite/presets/base';
import browserAppPreset from './tooling/vite/presets/browser-app';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDev = mode === 'development';

  // CSP: 'unsafe-inline' for styles is only needed in dev mode where Vite HMR
  // injects <style> tags. In production all CSS is bundled into a single file
  // served from 'self', so a strict hash/self policy suffices.
  // Allow WebAssembly compilation without enabling JavaScript eval()/Function().
  const styleSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
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
