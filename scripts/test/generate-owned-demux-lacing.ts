#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

type Packet = { type: 'key' | 'delta'; size: number; sha256: string };
type Oracle = {
  fixtures: { id: string; input: { size: number; sha256: string }; packets: Packet[] }[];
};

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function vint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid EBML size');
  for (let width = 1; width <= 8; width++) {
    const bits = BigInt(width * 7);
    if (BigInt(value) >= (1n << bits) - 1n) continue;
    let encoded = BigInt(value) | (1n << bits);
    const bytes = Buffer.alloc(width);
    for (let at = width - 1; at >= 0; at--) {
      bytes[at] = Number(encoded & 0xffn);
      encoded >>= 8n;
    }
    return bytes;
  }
  throw new Error('EBML size out of scope');
}

function element(id: string, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(id, 'hex'), vint(body.length), body]);
}

function unsigned(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid EBML integer');
  let width = 1;
  while (value >= 2 ** (width * 8)) width++;
  const bytes = Buffer.alloc(width);
  let remaining = BigInt(value);
  for (let at = width - 1; at >= 0; at--) {
    bytes[at] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function findKey(source: Buffer, packet: Packet): Buffer {
  if (packet.size < 1 || packet.size > source.length) throw new Error('Invalid oracle key');
  for (let at = 0; at + packet.size <= source.length; at++) {
    const candidate = source.subarray(at, at + packet.size);
    if (hash(candidate) === packet.sha256) return Buffer.from(candidate);
  }
  throw new Error('Oracle key bytes absent from owned source');
}

function makeWebm(
  mode: 'xiph' | 'fixed' | 'ebml',
  frame: Buffer,
  frameDurationNs = 250_000_000
): Buffer {
  const header = element(
    '1a45dfa3',
    Buffer.concat([
      element('4286', unsigned(1)),
      element('42f7', unsigned(1)),
      element('42f2', unsigned(4)),
      element('42f3', unsigned(8)),
      element('4282', Buffer.from('webm')),
      element('4287', unsigned(4)),
      element('4285', unsigned(2)),
    ])
  );
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE((frameDurationNs / 1_000_000) * 3);
  const info = element(
    '1549a966',
    Buffer.concat([
      element('2ad7b1', unsigned(1_000_000)),
      element('4489', duration),
      element('4d80', Buffer.from('owned-demux-test')),
      element('5741', Buffer.from('owned-demux-test')),
    ])
  );
  const video = element(
    'e0',
    Buffer.concat([element('b0', unsigned(16)), element('ba', unsigned(16))])
  );
  const track = element(
    'ae',
    Buffer.concat([
      element('d7', unsigned(1)),
      element('73c5', unsigned(1)),
      element('83', unsigned(1)),
      element('86', Buffer.from('V_VP8')),
      element('23e383', unsigned(frameDurationNs)),
      video,
    ])
  );
  const tracks = element('1654ae6b', track);
  const lace =
    mode === 'xiph'
      ? Buffer.from([2, frame.length, frame.length])
      : mode === 'fixed'
        ? Buffer.from([2])
        : Buffer.concat([Buffer.from([2]), vint(frame.length), vint(63)]);
  const flags = mode === 'xiph' ? 0x82 : mode === 'fixed' ? 0x84 : 0x86;
  const block = element(
    'a3',
    Buffer.concat([Buffer.from([0x81, 0, 0, flags]), lace, frame, frame, frame])
  );
  const cluster = element('1f43b675', Buffer.concat([element('e7', unsigned(0)), block]));
  return Buffer.concat([header, element('18538067', Buffer.concat([info, tracks, cluster]))]);
}

function main(): void {
  const [sourceArg, oracleArg, outputArg, extra] = process.argv.slice(2);
  if (
    !sourceArg ||
    !oracleArg ||
    !outputArg ||
    (process.argv.length !== 5 && !(process.argv.length === 6 && extra === '--long-hold'))
  ) {
    throw new Error(
      'Usage: generate-owned-demux-lacing.ts <owned-source.webm> <oracle.json> <outside-repo-output-dir>'
    );
  }
  const sourcePath = resolve(sourceArg);
  const oraclePath = resolve(oracleArg);
  const outputDir = resolve(outputArg);
  const repositoryDir = resolve('.');
  if (outputDir === repositoryDir || outputDir.startsWith(repositoryDir + sep)) {
    throw new Error('Lacing fixtures must stay outside the repository');
  }
  const source = readFileSync(sourcePath);
  if (source.length > 1024 * 1024)
    throw new Error('Source fixture exceeds bounded generator scope');
  const oracleBytes = readFileSync(oraclePath);
  const oracle = JSON.parse(oracleBytes.toString('utf8')) as Oracle;
  const fixture = oracle.fixtures.find((item) => item.id === basename(sourcePath));
  if (fixture?.input.size !== source.length || fixture.input.sha256 !== hash(source)) {
    throw new Error('Owned source differs from frozen oracle identity');
  }
  const key = fixture?.packets.find((packet) => packet.type === 'key');
  if (!key) throw new Error('Oracle has no key packet for source fixture');
  if (key.size >= 255) throw new Error('Xiph one-byte fixture requires a short key');
  const frame = findKey(source, key);
  mkdirSync(outputDir, { recursive: true });
  const outputs = (['xiph', 'fixed', 'ebml'] as const).map((mode) => {
    const bytes = makeWebm(mode, frame);
    const name = 'owned-lacing-' + mode + '.webm';
    writeFileSync(resolve(outputDir, name), bytes);
    return { name, mode, bytes: bytes.length, sha256: hash(bytes) };
  });
  if (extra === '--long-hold') {
    const bytes = makeWebm('fixed', frame, 5_000_000_000);
    const name = 'owned-lacing-long-hold.webm';
    writeFileSync(resolve(outputDir, name), bytes);
    outputs.push({ name, mode: 'fixed', bytes: bytes.length, sha256: hash(bytes) });
  }
  const manifest = {
    source: { name: basename(sourcePath), sha256: hash(source) },
    oracle: { sha256: hash(oracleBytes), packetSha256: key.sha256 },
    frame: { bytes: frame.length, sha256: hash(frame), repeated: 3 },
    timescaleNs: 1_000_000,
    baseDefaultDurationNs: 250_000_000,
    longHoldDefaultDurationNs: extra === '--long-hold' ? 5_000_000_000 : null,
    declaredDurationNs: 750_000_000,
    outputs,
  };
  writeFileSync(
    resolve(outputDir, 'owned-lacing-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log(JSON.stringify(outputs));
}

main();
