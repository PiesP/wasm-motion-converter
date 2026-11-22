import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, it } from 'vite-plus/test';

const root = resolve(import.meta.dirname, '../../../public/notices/historical-gif');
const index = readFileSync(join(root, 'index.html'), 'utf8');
const observed = readFileSync(
  resolve(import.meta.dirname, '../../fixtures/historical-gif-recipients.tsv'),
  'utf8'
);
const projectUrl = 'https://github.com/PiesP/wasm-motion-converter';
const omittedNotice = '270e5bd71479a1f957b6d32117d80eeb679f4de91999fd4687b8678e6f5b5944';

function section(id: string) {
  const start = index.indexOf(`<h2 id="${id}">`);
  expect(start, id).toBeGreaterThanOrEqual(0);
  const end = index.indexOf('<h2 ', start + 1);
  return index.slice(start, end === -1 ? index.length : end);
}

it('preserves the exact notice bytes linked from the historical GIF recipient index', () => {
  const linked = [...index.matchAll(/href="original\/([a-f0-9]{64}\.md)"/g)].map(
    (match) => match[1]
  );
  const files = readdirSync(join(root, 'original')).sort();

  expect(files).toHaveLength(14);
  expect([...new Set(linked)].sort()).toEqual(files);
  for (const file of files) {
    const bytes = readFileSync(join(root, 'original', file));
    expect(createHash('sha256').update(bytes).digest('hex') + '.md').toBe(file);
  }
});

// This fixture records the historical release/deployment receipts independently of the HTML.
// A correctly hashed file linked to the wrong deployment must still fail.
it.each([
  ['release', 'releases', 7],
  ['rust', 'rust', 15],
  ['preview', 'previews', 3],
  ['omission', 'omissions', 40],
] as const)(
  'binds every %s recipient to its recorded source and notice',
  (group, sectionId, count) => {
    const block = section(sectionId);
    const rows = new Map<string, string>();
    for (const match of block.matchAll(
      /<tr>\s*<th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g
    )) {
      const key = match[1]!.replace(/<\/?code>/g, '').trim();
      expect(rows.has(key), key).toBe(false);
      rows.set(key, match[2]!);
    }

    const expected = observed
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split('\t'))
      .filter(([kind]) => kind === group);
    expect(expected).toHaveLength(count);
    expect(rows.size).toBe(count);
    for (const fields of expected) {
      const [, key, source, original, artifacts, version] = fields;
      const row = rows.get(key!);
      expect(row, key).toBeDefined();
      const body = row!;
      const projectRefs = [
        ...body.matchAll(
          /github\.com\/PiesP\/wasm-motion-converter\/(?:blob|tree)\/([a-f0-9]{40})/g
        ),
      ];
      expect([...new Set(projectRefs.map((item) => item[1]))], key).toEqual(
        source === '-' ? [] : [source]
      );
      if (source !== '-') expect(body, key).toContain(`href="${projectUrl}/tree/${source}"`);
      const noticeLocation = group === 'omission' ? block.slice(0, block.indexOf('<table>')) : body;
      const noticeLinks = [...noticeLocation.matchAll(/href="original\/([a-f0-9]{64})\.md"/g)];
      expect(
        noticeLinks.map((item) => item[1]),
        key
      ).toEqual([original]);
      if (artifacts !== '-') {
        for (const sha of artifacts!.split(',')) expect(body, key).toContain(`<code>${sha}</code>`);
      }
      if (group === 'rust')
        expect(body, key).toContain(`>Rust ${version} sources and Cargo inputs</a>`);
      if (group === 'omission') {
        expect(original).toBe(omittedNotice);
        expect(body, key).toContain(
          `href="https://registry.npmjs.org/mediabunny/-/mediabunny-${version}.tgz">${version}</a>`
        );
      }
    }
  }
);

it('preserves the 121 historical notice fingerprints and their 622 observations', () => {
  const name = 'early-notice-fingerprints.tsv';
  expect(section('errata')).toContain(`href="${name}"`);
  const bytes = readFileSync(join(root, name));
  // CRLF conversion of checked-out text does not change the records.
  const text = bytes.toString('utf8').replaceAll('\r\n', '\n');
  expect(createHash('sha256').update(text).digest('hex')).toBe(
    'b83774bffdf069f69759356c7068f634bd66ac126bef18b94e761aff4bebcc64'
  );
  const records = text
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'));
  const fingerprints = new Set(records.map(([digest]) => digest));
  expect(fingerprints.size).toBe(121);
  expect(records.reduce((sum, [, count]) => sum + Number(count), 0)).toBe(622);
  for (const name of readdirSync(join(root, 'original'))) {
    const notice = readFileSync(join(root, 'original', name), 'utf8');
    if (notice.includes('No patent retaliation clause applies')) {
      expect(fingerprints.has(name.slice(0, -3)), name).toBe(true);
    }
  }
});

it('preserves deployment-specific source and patch choices under shared notice hashes', () => {
  const filename = 'early-deployment-sources.tsv';
  expect(section('errata')).toContain(`href="${filename}"`);
  const text = readFileSync(join(root, filename), 'utf8').replaceAll('\r\n', '\n');
  expect(createHash('sha256').update(text).digest('hex')).toBe(
    'b91d9fedf4e2aafdfe480896371079b5b7b8f7922ccbf9045f09c7eaa4e0ad59'
  );
  const rows = text
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'));
  expect(rows).toHaveLength(622);
  expect(new Set(rows.map(([id]) => id)).size).toBe(622);
  expect(new Set(rows.map(([, sha]) => sha)).size).toBe(121);
  expect(rows.filter((row) => row[4] !== '-')).toHaveLength(117);
  expect(rows.filter((row) => row[5] === '3b7d18921cc3300851db8fd03353e0afa95fa7c0')).toHaveLength(
    11
  );
  // These two deployments shared the same notice and package version, but only one applied a patch.
  const examples = rows.filter(([id]) => id === '2083a6b3' || id === '41eef875');
  expect(examples.map(([, hash, , version, patch]) => [hash, version, patch])).toEqual([
    [
      '6ca779a656b96974dc005a2304e6c8c1abef5f303b690f4fce314a13da2f5c30',
      '1.59.1',
      '095f3d2b2716bdb2dadad0540342dce8f1b7c2ec2d8af2b94251a621ac70603c',
    ],
    ['6ca779a656b96974dc005a2304e6c8c1abef5f303b690f4fce314a13da2f5c30', '1.59.1', '-'],
  ]);
});

it('keeps source and applicability links for compiler and external core corrections', () => {
  const rust = section('rust');
  expect(rust).toContain('/2026-10-15/rust-std-1.99.1-wasm32-unknown-unknown.tar.xz"');
  expect(rust).toContain('5f628f857dd00a8aa3fcac2e275665d2782066a5795274ed124c5b560f46423c');
  expect(rust).toContain('href="../rust-1.100.0.html"');
  const ffmpeg = section('ffmpeg');
  expect(ffmpeg).toContain('/dd114f79beb142b1464d5819d15b1f35a0006099/public/cdn-integrity.json');
  expect(ffmpeg).toContain(
    'sha384-IXnr5PE2UFcQ5DvI5LyubPqmMF46EkyIMlbdn4CNQR1iQ8/2irEkyhDFnVDxv4f/'
  );
});
