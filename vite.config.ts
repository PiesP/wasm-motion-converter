import path from 'node:path';
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

  return {
    plugins: [
      solid(),
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
      },
    },

    worker: {
      format: 'es',
    },

    server: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },

    preview: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },

    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 1000,
      cssCodeSplit: true,
      sourcemap: false,
      minify: 'esbuild',

      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: 'assets/[name].[hash].js',
          chunkFileNames: 'assets/[name].[hash].js',
          assetFileNames: 'assets/[name].[hash].[ext]',
          preserveModules: false,
          exports: 'auto',
        },
      },
    },
  };
});
