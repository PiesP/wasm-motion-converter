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
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { visualizer } from 'rollup-plugin-visualizer';
import type { Plugin, PluginOption } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import solid from 'vite-plugin-solid';

/**
 * Service Worker compilation plugin API interface
 */
interface SWCompilePluginAPI {
  getCompiledSWRCode: () => string;
}

/**
 * Service Worker compilation plugin with typed API
 */
interface SWCompilePlugin extends Plugin {
  api: SWCompilePluginAPI;
}

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

/**
 * Import map plugin for CDN dependencies
 *
 * Generates browser import map for loading dependencies from external CDNs.
 * Enables native ESM imports while reducing bundle size by ~36%.
 *
 * Import maps allow:
 * - import 'solid-js' → resolves to https://esm.sh/solid-js@1.9.10
 * - import 'modern-gif' → resolves to https://esm.sh/modern-gif@2.0.4
 *
 * Phase 1: Generates import map but dependencies still bundled
 * Phase 3: Dependencies externalized, import map becomes active
 *
 * @returns Vite plugin for import map injection
 */
function importMapPlugin(): Plugin {
  return {
    name: 'generate-import-map',
    transformIndexHtml(html) {
      // Inline import map generation (avoids circular dependency)
      // Based on generateImportMap() from cdn-constants.ts
      const importMap = {
        imports: {
          'solid-js': 'https://esm.sh/solid-js@1.9.10?target=esnext',
          'solid-js/web': 'https://esm.sh/solid-js@1.9.10/web?target=esnext',
          'solid-js/store': 'https://esm.sh/solid-js@1.9.10/store?target=esnext',
          'solid-js/h': 'https://esm.sh/solid-js@1.9.10/h?target=esnext',
          'solid-js/html': 'https://esm.sh/solid-js@1.9.10/html?target=esnext',
          'modern-gif': 'https://esm.sh/modern-gif@2.0.4',
          comlink: 'https://esm.sh/comlink@4.4.2',
        },
      };

      // Create import map script tag
      // Must be placed before any module scripts to be effective
      const scriptTag = `<script type="importmap">${JSON.stringify(importMap, null, 2)}</script>`;

      // Inject before closing </head> tag
      const transformed = html.replace('</head>', `  ${scriptTag}\n  </head>`);

      console.log('ℹ Import map generated with CDN URLs');

      return transformed;
    },
  };
}

/**
 * Service Worker compilation plugin
 *
 * Compiles TypeScript service worker files to JavaScript during build.
 * Uses esbuild for fast, reliable compilation with proper minification.
 *
 * Build flow:
 * 1. buildStart: Compile .ts files to .js using esbuild
 * 2. closeBundle: Rename temp files and clean up source .ts files
 *
 * @returns Vite plugin for service worker compilation
 */
function compileServiceWorkerPlugin(): SWCompilePlugin {
  let isDev = false;
  let compiledSWCode = '';
  let compiledSWRCode = '';

  return {
    name: 'compile-service-worker',

    configResolved(config) {
      isDev = config.mode === 'development';
    },

    async buildStart() {
      if (isDev) {
        console.log('ℹ Service Worker compilation skipped in dev mode');
        return;
      }

      console.log('ℹ Compiling Service Worker files...');

      const projectRoot = process.cwd();
      const publicDir = path.join(projectRoot, 'public');
      const tempDir = path.join(projectRoot, '.vite-sw-temp');

      try {
        // Create temp directory outside dist to avoid Vite cleaning
        if (!existsSync(tempDir)) {
          mkdirSync(tempDir, { recursive: true });
        }

        // Compile service-worker.ts
        await esbuild({
          entryPoints: [path.join(publicDir, 'service-worker.ts')],
          outfile: path.join(tempDir, 'service-worker.js'),
          bundle: false,
          format: 'esm',
          target: 'es2020',
          minify: true,
          sourcemap: false,
          platform: 'browser',
          logLevel: 'warning',
        });

        // Compile sw-register.ts
        await esbuild({
          entryPoints: [path.join(publicDir, 'sw-register.ts')],
          outfile: path.join(tempDir, 'sw-register.js'),
          bundle: false,
          format: 'esm',
          target: 'es2020',
          minify: true,
          sourcemap: false,
          platform: 'browser',
          logLevel: 'warning',
        });

        // Read compiled code into memory
        compiledSWCode = readFileSync(path.join(tempDir, 'service-worker.js'), 'utf-8');
        compiledSWRCode = readFileSync(path.join(tempDir, 'sw-register.js'), 'utf-8');

        console.log('✓ Service Worker files compiled successfully');
      } catch (error) {
        console.error('✗ Service Worker compilation failed:', error);
        throw error;
      }
    },

    writeBundle() {
      if (isDev) return;

      const distDir = path.join(process.cwd(), 'dist');

      try {
        // Write service-worker.js to dist
        writeFileSync(path.join(distDir, 'service-worker.js'), compiledSWCode);
        console.log('✓ Service Worker written to dist/service-worker.js');
      } catch (error) {
        console.error('✗ Failed to write service worker:', error);
        throw error;
      }
    },

    closeBundle() {
      if (isDev) return;

      const projectRoot = process.cwd();
      const tempDir = path.join(projectRoot, '.vite-sw-temp');
      const distDir = path.join(projectRoot, 'dist');

      try {
        // Clean up temp directory
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }

        // Delete source TypeScript files from dist/ if they were copied
        const swTS = path.join(distDir, 'service-worker.ts');
        const swrTS = path.join(distDir, 'sw-register.ts');

        if (existsSync(swTS)) {
          unlinkSync(swTS);
          console.log('✓ Removed service-worker.ts from dist/');
        }

        if (existsSync(swrTS)) {
          unlinkSync(swrTS);
          console.log('✓ Removed sw-register.ts from dist/');
        }
      } catch (error) {
        console.warn('⚠ Service Worker cleanup encountered errors:', error);
      }
    },

    // Provide compiled code to injection plugin
    api: {
      getCompiledSWRCode() {
        return compiledSWRCode;
      },
    },
  };
}

/**
 * Service Worker registration injection plugin
 *
 * Inlines service worker registration code into HTML <head>.
 * Avoids additional HTTP request and ensures early registration.
 *
 * Registration code:
 * - Checks for Service Worker API support
 * - Registers /service-worker.js with proper error handling
 * - Handles update notifications
 *
 * @returns Vite plugin for SW registration injection
 */
function injectServiceWorkerPlugin(compilePlugin: SWCompilePlugin): Plugin {
  let isDev = false;

  return {
    name: 'inject-service-worker-registration',

    configResolved(config) {
      isDev = config.mode === 'development';
    },

    transformIndexHtml(html) {
      if (isDev) {
        console.log('ℹ Service Worker registration skipped in dev mode');
        return html;
      }

      let registrationCode = '';

      // Get compiled code from compilation plugin API
      const compiledCode = compilePlugin.api.getCompiledSWRCode();

      if (compiledCode) {
        registrationCode = `
<script type="module">
// Service Worker Registration (inlined for immediate execution)
${compiledCode}

// Auto-register on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
  });
} else {
  registerServiceWorker();
}
</script>`;
      } else {
        // Fallback registration
        registrationCode = `
<script type="module">
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/',
        type: 'classic',
      });
      console.log('[SW] Registered successfully:', registration.scope);

      setInterval(() => {
        registration.update().catch(() => {});
      }, 60 * 60 * 1000);
    } catch (error) {
      console.error('[SW] Registration failed:', error);
    }
  });
} else {
  console.warn('[SW] Service Workers not supported');
}
</script>`;
      }

      const transformed = html.replace('</head>', `  ${registrationCode}\n  </head>`);
      console.log('✓ Service Worker registration injected into HTML');

      return transformed;
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load environment variables based on mode (development/production)
  const env = loadEnv(mode, process.cwd(), '');

  // Create service worker compilation plugin (needed by injection plugin)
  const swCompilePlugin = compileServiceWorkerPlugin();

  return {
    // Vite plugins configuration
    plugins: [
      solid(), // SolidJS JSX transformation and HMR
      htmlTransformPlugin(env), // Inject AdSense code conditionally
      generateAdsTxtPlugin(env), // Generate ads.txt for AdSense verification
      importMapPlugin(), // Generate import map for CDN dependencies (Phase 1)
      swCompilePlugin, // Compile service worker TypeScript to JavaScript
      injectServiceWorkerPlugin(swCompilePlugin), // Inline service worker registration in HTML
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
        // External dependencies (loaded from CDN via import map)
        // Phase 3.1: Externalize comlink (lowest risk)
        // Phase 3.2: Externalize modern-gif (medium risk)
        // Phase 3.3: Externalize solid-js (highest risk - requires ?target=esnext)
        external: [
          'comlink',
          'modern-gif',
          'solid-js',
          'solid-js/web',
          'solid-js/store',
          'solid-js/h',
          'solid-js/html',
        ],

        output: {
          format: 'es', // ES module format for tree-shaking

          // Manual code splitting for optimal long-term caching
          // Separates stable vendor code from frequently-changing app code
          // Vendor bundles change rarely, so browsers can cache them longer
          manualChunks: {
            // 'vendor-solid': ['solid-js'], // REMOVED: Now loaded from CDN (Phase 3.3)
            'vendor-ffmpeg': ['@ffmpeg/ffmpeg', '@ffmpeg/util'], // FFmpeg WASM (~4.5KB gzipped)
            // 'vendor-gif': ['modern-gif'], // REMOVED: Now loaded from CDN (Phase 3.2)
            // 'vendor-comlink': ['comlink'], // REMOVED: Now loaded from CDN (Phase 3.1)
          },
        },
      },
    },
  };
});
