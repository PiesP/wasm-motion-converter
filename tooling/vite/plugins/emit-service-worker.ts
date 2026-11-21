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
        const predecessorShared: string[] = [];
        const predecessorOnly = Object.entries(predecessorAssets)
          .filter(([path, sha256]) => {
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
