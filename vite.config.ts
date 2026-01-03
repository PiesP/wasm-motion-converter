import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [
    solid(),
    visualizer({
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
    }),
  ],
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
  // Vite dependency pre-bundling can break @ffmpeg/ffmpeg's internal worker URL rewriting
  // (it may point to a non-existent /node_modules/.vite/deps/worker.js). Excluding it keeps
  // the worker module resolvable in dev.
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg'],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          ffmpeg: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
        },
      },
    },
  },
});
