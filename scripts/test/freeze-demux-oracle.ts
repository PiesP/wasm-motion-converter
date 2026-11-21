#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { execFileSync } from 'node:child_process';
/** Freeze local, development-oracle traces without retaining compressed payloads. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { basename, dirname, resolve } from 'node:path';

import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';

import {
  ENCODED_PACKET_BUDGET_BYTES,
  MEDIA_BUNNY_BUFFER_BUDGET_BYTES,
  MP4_MAX_LOGICAL_SAMPLES,
  MP4_METADATA_BUDGET_BYTES,
} from '../../src/utils/constants.ts';

const root = resolve(import.meta.dirname, '../..');
const packageName = 'mediabunny';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Select an indentation-scoped block in the canonical pnpm-generated lock.
function lockSection(lines: string[], header: string): string[] {
  const start = lines.indexOf(header);
  if (start === -1) return [];
  const childIndent = ' '.repeat(header.length - header.trimStart().length + 1);
  const end = lines.findIndex(
    (line, index) => index > start && line !== '' && !line.startsWith(childIndent)
  );
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function verifyOracleInstallation() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageFile = findPackageJSON(import.meta.resolve(packageName));
  if (
    !packageFile ||
    realpathSync(packageFile) !==
      realpathSync(resolve(root, 'node_modules', packageName, 'package.json'))
  ) {
    throw new Error('Could not resolve MediaBunny from the local installation');
  }
  const installed = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    name?: string;
    version?: string;
  };
  const { version } = installed;
  if (
    installed.name !== packageName ||
    !version ||
    manifest.devDependencies?.[packageName] !== version ||
    manifest.dependencies?.[packageName] !== undefined
  ) {
    throw new Error('Installed MediaBunny does not match the exact development dependency');
  }

  const selector = `${packageName}@${version}`;
  const configArgs = ['config', 'get', 'patchedDependencies', '--json'];
  const config = JSON.parse(
    process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/c', 'pnpm config get patchedDependencies --json'], {
          cwd: root,
          encoding: 'utf8',
        })
      : execFileSync('pnpm', configArgs, { cwd: root, encoding: 'utf8' })
  ) as Record<string, string> | null;
  const patchPath = config?.[selector];
  if (!patchPath) throw new Error(`No configured patch for ${selector}`);
  const patch = readFileSync(resolve(root, patchPath));
  const patchSha256 = digest(patch);

  const lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'));
  // pnpm may put its own package-manager lock in a separate first document.
  const lock =
    lockfile.toString('utf8').replaceAll('\r\n', '\n').split(/^---$/m).at(-1)?.trim() ?? '';
  const lockLines = lock.split('\n');
  const rootImporter = lockSection(lockSection(lockLines, 'importers:'), '  .:');
  const lockedDevelopment = lockSection(rootImporter, '    devDependencies:');
  const lockedDependency = lockSection(lockedDevelopment, `      ${packageName}:`);
  const expectedDependency = [
    `        specifier: ${version}`,
    `        version: ${version}(patch_hash=${patchSha256})`,
  ].join('\n');
  if (
    !lockSection(lockLines, 'patchedDependencies:').includes(`  ${selector}: ${patchSha256}`) ||
    lockedDependency.join('\n').trimEnd() !== expectedDependency
  ) {
    throw new Error(`pnpm lockfile does not select the configured patch for ${selector}`);
  }
  const modules = JSON.parse(readFileSync(resolve(root, 'node_modules/.modules.yaml'), 'utf8')) as {
    virtualStoreDir: string;
  };
  const installedLock = readFileSync(
    resolve(root, 'node_modules', modules.virtualStoreDir, 'lock.yaml'),
    'utf8'
  );
  if (installedLock.replaceAll('\r\n', '\n').trim() !== lock) {
    throw new Error('Installed pnpm lock does not match pnpm-lock.yaml. Run a frozen install.');
  }

  const packageDir = dirname(packageFile);
  // In a linked worktree Git would otherwise scope patch paths to node_modules.
  try {
    execFileSync('git', ['apply', '--reverse', '--check', '-'], {
      cwd: packageDir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(packageDir) },
      input: patch,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (cause) {
    throw new Error(`Installed MediaBunny files do not match the patch for ${selector}`, { cause });
  }
  return { package: packageName, version, patchSha256, lockSha256: digest(lockfile) };
}

function description(
  value: ArrayBufferLike | ArrayBufferView<ArrayBufferLike> | undefined
): string | null {
  if (!value) return null;
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return Buffer.from(bytes).toString('hex');
}

export async function freezeOracle(path: string): Promise<unknown> {
  const bytes = readFileSync(path);
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  Object.assign(input, {
    _maxContiguousReadBytes: MEDIA_BUNNY_BUFFER_BUDGET_BYTES,
    _maxEncodedPacketBytes: ENCODED_PACKET_BUDGET_BYTES - 1024,
    _maxBufferedPacketBytes: MEDIA_BUNNY_BUFFER_BUDGET_BYTES,
    _maxIsobmffMetadataBytes: MP4_METADATA_BUDGET_BYTES,
    _maxIsobmffSamples: MP4_MAX_LOGICAL_SAMPLES,
    _skipMatroskaDescriptiveMetadata: true,
  });
  try {
    const tracks = await input.getVideoTracks();
    const track = tracks[0];
    if (!track) throw new Error('No video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('No decoder configuration');
    const sink = new EncodedPacketSink(track);
    const packets = [];
    for await (const packet of sink.packets()) {
      if (packets.length >= 100_000) throw new Error('Fixture packet limit exceeded');
      packets.push({
        sequence: packets.length,
        timestampUs: packet.microsecondTimestamp,
        durationUs: packet.microsecondDuration,
        type: packet.type,
        size: packet.byteLength,
        sha256: digest(packet.data),
      });
    }
    const duration = await track.computeDuration();
    const decodedFrameHashCommand = [
      '-v',
      'error',
      '-i',
      '<input>',
      '-map',
      '0:v:0',
      '-pix_fmt',
      'rgba',
      '-fps_mode',
      'passthrough',
      '-f',
      'framehash',
      '-hash',
      'sha256',
      '-',
    ];
    const seek = [];
    for (const seconds of [
      0,
      0.125,
      0.6,
      Math.max(0, duration / 2),
      Math.max(0, duration - 0.01),
    ]) {
      const packet = await sink.getKeyPacket(seconds, { verifyKeyPackets: true });
      seek.push({
        seconds,
        packet: packet && {
          timestampUs: packet.microsecondTimestamp,
          durationUs: packet.microsecondDuration,
          type: packet.type,
          size: packet.byteLength,
          sha256: digest(packet.data),
        },
      });
    }
    return {
      id: basename(path),
      input: { size: bytes.length, sha256: digest(bytes) },
      videoTracks: tracks.length,
      config: { ...config, description: description(config.description) },
      rotation: await track.getRotation(),
      duration,
      stats: await track.computePacketStats(50),
      packets,
      seek,
      decodedFrameHashCommand,
      decodedFrameHashes: execFileSync(
        'ffmpeg',
        decodedFrameHashCommand.map((argument) => (argument === '<input>' ? path : argument)),
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
      ),
      independent: JSON.parse(
        execFileSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_streams',
            '-show_packets',
            '-show_data_hash',
            'sha256',
            '-of',
            'json',
            path,
          ],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
        )
      ),
    };
  } finally {
    input.dispose();
  }
}

if (import.meta.main) {
  const [output, ...paths] = process.argv.slice(2);
  if (!output || !paths.length) throw new Error('Usage: freeze-demux-oracle.ts OUTPUT INPUT...');
  const oracle = verifyOracleInstallation();
  const fixtures = [];
  for (const path of paths) {
    try {
      fixtures.push({ status: 'success', ...((await freezeOracle(resolve(path))) as object) });
    } catch (error) {
      fixtures.push({ id: basename(path), status: 'oracle-rejected', error: String(error) });
    }
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        schema: 1,
        source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        oracle,
        node: process.version,
        tools: {
          ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
          ffprobe: execFileSync('ffprobe', ['-version'], { encoding: 'utf8' }).split('\n')[0],
        },
        fixtures,
      },
      null,
      2
    ) + '\n'
  );
}
