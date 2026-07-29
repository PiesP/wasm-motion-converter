import type { Plugin } from 'vite';

const DATA_TEST_ID_PATTERN = /\s+data-testid="[^"]*"/g;

export function stripDataTestIdPlugin(): Plugin {
  return {
    name: 'strip-data-testid',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      if (!id.endsWith('.js') && !id.endsWith('.mjs')) return null;
      const stripped = code.replace(DATA_TEST_ID_PATTERN, '');
      if (stripped === code) return null;
      return { code: stripped, map: null };
    },
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'asset' && fileName.endsWith('.html')) {
          const html = chunk.source as string;
          const cleaned = html.replace(DATA_TEST_ID_PATTERN, '');
          if (cleaned !== html) {
            chunk.source = cleaned;
          }
        }
      }
    },
  };
}
