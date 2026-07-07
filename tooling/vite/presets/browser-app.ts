import type { UserConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

const browserAppPreset: UserConfig = {
  plugins: [solid(), tailwindcss()],

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
        manualChunks(id: string): string | undefined {
          // Keep wasm-webp out of the worker chunk — it's only needed for
          // the main-thread fallback path, not the OffscreenCanvas worker path.
          if (id.includes('wasm-webp')) {
            return 'wasm-webp';
          }
          if (id.includes('gifenc')) {
            return 'gifenc';
          }
          return undefined;
        },
      },
      onwarn(warning: { code?: string; message?: string }, defaultHandler: (w: { code?: string; message?: string }) => void) {
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

export default browserAppPreset;
