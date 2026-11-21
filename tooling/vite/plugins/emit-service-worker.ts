import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Plugin } from 'vite-plus';

const workerPath = fileURLToPath(new URL('../../../worker/service-worker.ts', import.meta.url));
const publicWorkerPath = fileURLToPath(
  new URL('../../../public/service-worker.js', import.meta.url)
);

// Non-codec assets from the signed 7d9e0f1b Pages manifest.
const predecessorAssets = {
  'assets/__vite-browser-external.leW0L_I9.js':
    'd7b40f2790c54c192fb6231f869ba3f808c98f1fb6b2a92ed7916a8ea8fb1008',
  'assets/ar.BV_h1dDz.js': '6475a9370935a41bd186aeaf7d00124c5620244e16a7915c73146c5bb2be19a8',
  'assets/conversion-pipeline.CWWiHRhM.js':
    'f8505acf315af76de49455239f2d3ba283969d9a0df13659c1503ef72f22f608',
  'assets/es.C6MHiEW-.js': 'ddccd9cda335a63b61ef7acada32a64df9fb97c25162481300f3504e3a18149d',
  'assets/gif-scalar-quantizer-C4eFz0Ox.wasm':
    'a0753c05b7b7163a15b5608fde8189e41466da7fddd9d1eb7250ef0f3dfcf23d',
  'assets/index.D-kAC8Cr.css': '9e9f235f0c36f43f59f762c5ab50c60b2f2291c26d73f127fe0429fcb8dab86d',
  'assets/index.D1rWSzxT.js': 'a1d79b4adb32cc3e317ee508abe2c4a23154a4e999a24e18b5562bf43c92bd82',
  'assets/ja.BbILiaIy.js': '64d1d94af557e6cb5fff3b450ea8bc6827c1227fedf693045f7b1734706ffad7',
  'assets/ko.D8gAwq2s.js': '96a055641129ceb8fcdd3fc8d490266f1822f27e6f86f791b01c2381eacd7974',
  'assets/owned-demux-index-snapshot.C0BBSK05.js':
    '571404f13490bb9a578110c260fb213ae1b8092bc78a18b3fde1ee29bde14b2a',
  'assets/owned-demux-vJnqndga.wasm':
    'f4132e72e2916bdc1693e436c3f4bd2e47735bcbff989a26c0f09ff42ee71f93',
  'assets/preload-helper.7y9sWmk5.js':
    '564eabb7e91110d437ceb9cb09dadea1e9bbbe5fcb5480b8d981c1a20d30f4fc',
  'assets/rolldown-runtime.XKyaHtl9.js':
    '548d1dbf321e7d2ae804fcc158b588706a7c52f8ca175de1490c6ccb4dbe55b7',
  'assets/video-metadata.Cxxzi8JH.js':
    '66b5619814a053d8212e2f66deacbeadb24a6e03c40be6d72799e51f50783711',
  'assets/webp-encoder-worker-Dt0iE3Ie.js':
    'bd7fcb5bb7cf7e284a4947b0c5d54d28560c48a9568d8998a9b092cd6504d44c',
  'assets/worker-BG8LzI1q.js': '18477517e1755f75dfc8f6216c846e4731f96620faf4265a509a2c3535c54113',
  'assets/zh-CN.CwDWTPax.js': '426b5a10ba1d26c7ad170efba00f9aff64ead49c96ca87f1f1012562d58027be',
};

// Exact application assets from the signed 02f1cc21 production Pages manifest.
export const replacedApp = {
  source: '02f1cc2188b83a7047f57f9b1ca8880ca74d5ec1',
  document: {
    size: 1951,
    sha256: 'a3157f85b58d5e4528f72810583cd2aad328c4c968228a9ff75db8aeacedfeb3',
  },
  workers: ['/assets/worker-B5-WTQ3J.js', '/assets/webp-encoder-worker-Dt0iE3Ie.js'],
  assets: [
    {
      path: '/assets/ar.Bx6XLOFp.js',
      size: 14541,
      sha256: 'e731202ab2e875bef81546088859bdb4be802884f7f03f7b7e5e9bf20ec09d85',
    },
    {
      path: '/assets/conversion-pipeline.D3cmESmf.js',
      size: 100466,
      sha256: '1b924e214d3a5eeeed8212c207cd911ca8161a5d90d30efa5964468065fe29cb',
    },
    {
      path: '/assets/es.C05aqTjO.js',
      size: 12260,
      sha256: '4b0529a5b9374595d9b265c82a3081d156baca60c4fdae70ba935f75de624cde',
    },
    {
      path: '/assets/gif-scalar-quantizer-C4eFz0Ox.wasm',
      size: 27338,
      sha256: 'a0753c05b7b7163a15b5608fde8189e41466da7fddd9d1eb7250ef0f3dfcf23d',
    },
    {
      path: '/assets/index.C5lvElWh.js',
      size: 214273,
      sha256: '44031951d2d278243aa8f0b44ab59b8e11cb8d7edca6dd489599ebab6fc21469',
    },
    {
      path: '/assets/index.CGzq1HU3.css',
      size: 52340,
      sha256: '1d0c92bc5aeff41661f2181bebe8a65a0f71fa06aaafc247259090c599d965e0',
    },
    {
      path: '/assets/ja.hQNQFHJA.js',
      size: 13393,
      sha256: '8f7468996ac5ece0feee2a28194027e813acacefabafc248e612edddb8d64dd8',
    },
    {
      path: '/assets/ko.CyrTV7ju.js',
      size: 12549,
      sha256: '661fc0218ba129085cd5cdcb4ed87a57c3b2927c178ffba18a813e091b4ede06',
    },
    {
      path: '/assets/owned-demux-index-snapshot.JaWZyltO.js',
      size: 34258,
      sha256: '4b933a655328e5c97c010329a58284b27bceff983b339955346ff96aa87cdddd',
    },
    {
      path: '/assets/owned-demux-vJnqndga.wasm',
      size: 138915,
      sha256: 'f4132e72e2916bdc1693e436c3f4bd2e47735bcbff989a26c0f09ff42ee71f93',
    },
    {
      path: '/assets/owned-vp8-CARrgNGb.wasm',
      size: 308560,
      sha256: 'a4ea21e83a1e7e74a643b72eff2797d8f0cd2b9522133a7ce946e5aaeedab526',
    },
    {
      path: '/assets/preload-helper.7y9sWmk5.js',
      size: 1615,
      sha256: '564eabb7e91110d437ceb9cb09dadea1e9bbbe5fcb5480b8d981c1a20d30f4fc',
    },
    {
      path: '/assets/video-metadata.Cg28k8uG.js',
      size: 1594,
      sha256: 'ead57564897fc7151d0d19c2b53c99e5b0fed33793980218f7d89945476c2ed8',
    },
    {
      path: '/assets/webp-encoder-worker-Dt0iE3Ie.js',
      size: 4181,
      sha256: 'bd7fcb5bb7cf7e284a4947b0c5d54d28560c48a9568d8998a9b092cd6504d44c',
    },
    {
      path: '/assets/worker-B5-WTQ3J.js',
      size: 138263,
      sha256: '05de038fc49df1867c7e6ac6de068981ae4994c91ccf2d8ada8a45985e15a4f7',
    },
    {
      path: '/assets/zh-CN.C---bIH_.js',
      size: 10417,
      sha256: 'a4f46c3adcc2fb4c219b03d7a353de7c3263b890fac66626a4cf62436c63006f',
    },
  ],
};

export function emitServiceWorkerPlugin(): Plugin {
  return {
    name: 'emit-service-worker',
    apply: 'build',
    buildStart() {
      if (existsSync(publicWorkerPath)) {
        throw new Error('A handwritten public/service-worker.js would override the emitted worker');
      }
      this.emitFile({ type: 'chunk', id: workerPath, fileName: 'service-worker.js' });
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const workerChunks = Object.values(bundle).filter(
          (item) => item.type === 'chunk' && item.facadeModuleId === workerPath
        );
        if (
          workerChunks.length !== 1 ||
          workerChunks[0]?.type !== 'chunk' ||
          workerChunks[0].fileName !== 'service-worker.js'
        ) {
          throw new Error('Expected exactly one root service-worker.js chunk');
        }
        const worker = workerChunks[0];
        if (worker.imports.length || worker.dynamicImports.length) {
          throw new Error('The service worker must be one self-contained module');
        }

        const pin = (path: string) => {
          const item = bundle[path];
          if (!item) throw new Error(`Missing service worker shell asset: ${path}`);
          const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
          return { path: `/${path}`, size: bytes.length, sha256: digest(bytes) };
        };
        const document = pin('index.html');
        const html = bundle['index.html'];
        if (html?.type !== 'asset') throw new Error('Expected emitted application document');
        const files = new Set<string>();
        const pending = shellEntries(Buffer.from(html.source).toString('utf8'));
        while (pending.length) {
          const path = pending.pop()!;
          if (files.has(path)) continue;
          files.add(path);
          const item = bundle[path];
          if (item?.type === 'chunk') {
            pending.push(...item.imports);
            pending.push(...(item.viteMetadata?.importedCss ?? []));
          } else if (!path.endsWith('.css')) {
            throw new Error(`Unexpected application shell asset: ${path}`);
          }
        }
        const replacedPins = new Map(replacedApp.assets.map((asset) => [asset.path, asset.sha256]));
        const replacementOnly = replacedApp.assets.filter((asset) => {
          if (!bundle[asset.path.slice(1)]) return true;
          const current = pin(asset.path.slice(1));
          if (current.size !== asset.size || current.sha256 !== asset.sha256) {
            throw new Error(`Immutable replaced asset changed bytes at ${asset.path}`);
          }
          return false;
        });
        const replacementOnlyPaths = new Set(replacementOnly.map(({ path }) => path));
        const predecessorShared: string[] = [];
        const predecessorOnly = Object.entries(predecessorAssets)
          .filter(([path, sha256]) => {
            const replacementSha = replacedPins.get(`/${path}`);
            if (replacementSha && replacementSha !== sha256) {
              throw new Error(`Predecessor generations disagree on immutable asset ${path}`);
            }
            if (!bundle[path]) return true;
            if (pin(path).sha256 !== sha256) {
              throw new Error(`Immutable predecessor asset changed bytes at ${path}`);
            }
            predecessorShared.push(`/${path}`);
            return false;
          })
          .map(([path]) => `/${path}`);
        const manifest = JSON.stringify({
          document,
          eager: [...files].sort().map(pin),
          predecessorOnly,
          predecessorShared,
          replacement: {
            source: replacedApp.source,
            document: replacedApp.document,
            workers: replacedApp.workers,
            only: replacementOnly,
            shared: replacedApp.assets.filter(({ path }) => !replacementOnlyPaths.has(path)),
          },
        });
        const sourceHash = digest(readFileSync(workerPath));
        worker.code =
          `/* dropconvert-worker-source-sha256:${sourceHash} */\n` +
          `const __DROP_CONVERT_SHELL__=${manifest};\n${worker.code}`;
      },
    },
  };
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function shellEntries(html: string): string[] {
  const entries = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1];
    const mode = attr('rel') ?? attr('type');
    if (mode !== 'stylesheet' && mode !== 'modulepreload' && mode !== 'module') continue;
    const path = attr('src') ?? attr('href');
    if (!path || !/^\/assets\/[\w.-]+\.(?:js|css)$/.test(path)) {
      throw new Error(`Unexpected application shell URL: ${path}`);
    }
    entries.push(path.slice(1));
  }
  if (!entries.some((path) => path.endsWith('.js'))) {
    throw new Error('Expected an application shell module');
  }
  return entries;
}
