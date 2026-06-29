import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin, PluginOption } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import solid from 'vite-plugin-solid';

function stripDataTestIdPlugin(): Plugin {
  return {
    name: 'strip-data-testid',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      if (!id.endsWith('.js') && !id.endsWith('.mjs')) return null;
      const stripped = code.replace(/\s+data-testid="[^"]*"/g, '');
      if (stripped === code) return null;
      return { code: stripped, map: null };
    },
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && fileName.endsWith('.html')) {
          const html = chunk.source as string;
          const cleaned = html.replace(/\s+data-testid="[^"]*"/g, '');
          if (cleaned !== html) {
            chunk.source = cleaned;
          }
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isDev = mode === 'development';

  // CSP: 'unsafe-inline' for styles is only needed in dev mode where Vite HMR
  // injects <style> tags. In production all CSS is bundled into a single file
  // served from 'self', so a strict hash/self policy suffices.
  // 'unsafe-eval' is needed for WebAssembly (wasm-webp, gifenc use dynamic compilation).
  const styleSrc = isDev ? "'self' 'unsafe-inline'" : "'self'";
  const scriptSrc = isDev ? "'self' 'unsafe-eval'" : "'self'";

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' blob: data:",
    "connect-src 'self' blob:",
    "worker-src 'self'",
  ].join('; ');

  return {
    plugins: [
      solid(),
      tailwindcss(),
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
    ],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@components': path.resolve(__dirname, './src/components'),
        '@services': path.resolve(__dirname, './src/services'),
        '@utils': path.resolve(__dirname, './src/utils'),
        '@stores': path.resolve(__dirname, './src/stores'),
        '@hooks': path.resolve(__dirname, './src/hooks'),
        '@t': path.resolve(__dirname, './src/types'),
        '@i18n': path.resolve(__dirname, './src/i18n'),
      },
    },

    worker: {
      format: 'es',
    },

    server: {
      headers: {
        'Content-Security-Policy': csp,
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },

    preview: {
      headers: {
        'Content-Security-Policy': csp,
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },

    optimizeDeps: {
      include: ['wasm-webp', 'gifenc', 'mediabunny'],
    },

    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 1000,
      cssCodeSplit: true,
      sourcemap: false,
      rolldownOptions: {
        output: {
          format: 'es',
          entryFileNames: 'assets/[name].[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: 'assets/[name].[hash].[ext]',
          preserveModules: false,
          exports: 'auto',
        },
        onwarn(warning, defaultHandler) {
          // Suppress "module" externalization warning from wasm-webp
          if (
            warning.code === 'MODULE_LEVEL_DIRECTIVE' ||
            warning.message?.includes('Module "module" has been externalized')
          ) {
            return;
          }
          defaultHandler(warning);
        },
      },
    },
  };
});
