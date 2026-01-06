/**
 * Vite Configuration
 *
 * Configures Vite build system for SolidJS application with:
 * - FFmpeg.wasm cross-origin isolation (SharedArrayBuffer support)
 * - Dynamic AdSense integration via environment variables
 * - Path aliases for cleaner imports
 * - Manual code splitting for optimal caching
 * - Bundle analysis via rollup-plugin-visualizer
 *
 * @see https://vite.dev/config/
 * @see CODE_STANDARDS.md Section 1 (File Organization)
 * @see AGENTS.md for FFmpeg SharedArrayBuffer requirements
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin, PluginOption } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import solid from 'vite-plugin-solid';

/**
 * HTML transform plugin for injecting AdSense code conditionally
 *
 * Replaces %%ADSENSE_META%% and %%ADSENSE_SCRIPT%% placeholders in index.html
 * with actual AdSense code when VITE_ENABLE_ADS=true and publisher ID is set.
 *
 * @param env - Environment variables loaded by Vite
 * @returns Vite plugin for HTML transformation
 */
function htmlTransformPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'html-transform',
    transformIndexHtml(html) {
      const enableAds = env.VITE_ENABLE_ADS === 'true';
      const publisherId = env.VITE_ADSENSE_PUBLISHER_ID || '';

      let transformed = html;

      if (enableAds && publisherId) {
        // Inject AdSense meta tag
        const metaTag = `<meta name="google-adsense-account" content="${publisherId}">`;
        transformed = transformed.replace('%%ADSENSE_META%%', metaTag);

        // Inject AdSense script
        const scriptTag = `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}" crossorigin="anonymous"></script>`;
        transformed = transformed.replace('%%ADSENSE_SCRIPT%%', scriptTag);
      } else {
        // Remove placeholders in development
        transformed = transformed.replace('%%ADSENSE_META%%', '<!-- AdSense disabled -->');
        transformed = transformed.replace('%%ADSENSE_SCRIPT%%', '<!-- AdSense disabled -->');
      }

      return transformed;
    },
  };
}

/**
 * Plugin to dynamically generate public/ads.txt from environment variables
 *
 * Creates ads.txt file required by Google AdSense for ad serving verification.
 * Only generates when VITE_ENABLE_ADS=true and valid publisher ID is provided.
 *
 * @param env - Environment variables loaded by Vite
 * @returns Vite plugin for ads.txt generation
 */
function generateAdsTxtPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'generate-ads-txt',
    buildStart() {
      const enableAds = env.VITE_ENABLE_ADS === 'true';
      const publisherId = env.VITE_ADSENSE_PUBLISHER_ID || '';

      // Only generate ads.txt if ads are enabled and publisher ID is set
      if (enableAds && publisherId && !publisherId.includes('XXXX')) {
        const publicDir = path.join(process.cwd(), 'public');
        const adsTxtPath = path.join(publicDir, 'ads.txt');

        // Extract numeric ID from ca-pub-XXXXXXXXXXXXXXXX
        const numericId = publisherId.replace('ca-pub-', '');
        const adsTxtContent = `google.com, pub-${numericId}, DIRECT, f08c47fec0942fa0\n`;

        try {
          mkdirSync(publicDir, { recursive: true });
          writeFileSync(adsTxtPath, adsTxtContent, 'utf-8');
          console.log(`✓ Generated public/ads.txt with publisher ID: ${publisherId}`);
        } catch (error) {
          console.warn(`⚠ Failed to generate ads.txt:`, error);
        }
      } else {
        console.log('ℹ Skipping ads.txt generation (ads disabled or placeholder ID)');
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load environment variables based on mode (development/production)
  const env = loadEnv(mode, process.cwd(), '');

  return {
    // Vite plugins configuration
    plugins: [
      solid(), // SolidJS JSX transformation and HMR
      htmlTransformPlugin(env), // Inject AdSense code conditionally
      generateAdsTxtPlugin(env), // Generate ads.txt for AdSense verification
      visualizer({
        // Bundle analysis tool - generates dist/stats.html
        filename: 'dist/stats.html',
        gzipSize: true, // Calculate gzipped bundle sizes
        brotliSize: true, // Calculate brotli-compressed sizes
      }) as PluginOption,
    ],

    // Import path aliases (matches tsconfig.json paths)
    // Enables cleaner imports: '@components/...' instead of '../../components/...'
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@components': path.resolve(__dirname, './src/components'),
        '@services': path.resolve(__dirname, './src/services'),
        '@utils': path.resolve(__dirname, './src/utils'),
        '@stores': path.resolve(__dirname, './src/stores'),
        '@types': path.resolve(__dirname, './src/types'),
      },
    },

    // Development server configuration
    server: {
      // Required headers for SharedArrayBuffer support (FFmpeg.wasm multithreading)
      // Cross-origin isolation enables ffmpeg-core-mt.wasm worker threads
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },

    // Preview server configuration (same isolation requirements as dev)
    preview: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },

    // Dependency optimization configuration
    // Exclude @ffmpeg/ffmpeg from pre-bundling to prevent worker URL rewriting issues
    // Vite's dependency pre-bundling can break FFmpeg's internal worker module resolution
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg'],
    },

    // Production build configuration
    build: {
      target: 'esnext', // Target modern browsers with ESNext features
      rollupOptions: {
        output: {
          format: 'es', // ES module format for tree-shaking

          // Manual code splitting for optimal long-term caching
          // Separates stable vendor code from frequently-changing app code
          // Vendor bundles change rarely, so browsers can cache them longer
          manualChunks: {
            'vendor-solid': ['solid-js'], // SolidJS framework (~13KB gzipped)
            'vendor-ffmpeg': ['@ffmpeg/ffmpeg', '@ffmpeg/util'], // FFmpeg WASM (~4.5KB gzipped)
            'vendor-gif': ['modern-gif'], // GIF encoding library (~24KB gzipped)
            'vendor-comlink': ['comlink'], // Web Worker communication (~4KB gzipped)
          },
        },
      },
    },
  };
});
