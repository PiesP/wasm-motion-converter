// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ownedDecoderConfig, ownedTimestampUs } from '@services/owned-demux-config';
import { createOwnedDemuxSession } from '@services/owned-demux-core';
import { extractVideoMetadata } from '@services/video-metadata';
import { EncodedPacketSink } from 'mediabunny';
import { describe, expect, it } from 'vite-plus/test';

import oracle from '../../fixtures/owned-demux/oracle.json';
import { createMediaBunnyInput } from '../../helpers/mediabunny-oracle';

const sources = import.meta.glob('../../fixtures/owned-demux/*.base64', {
  eager: true,
  query: '?raw',
  import: 'default',
});

type DecodedFrame = {
  timestamp: number;
  codedWidth: number;
  codedHeight: number;
  visibleRect: { x: number; y: number; width: number; height: number };
  displayWidth: number;
  displayHeight: number;
  rgbaSha256: string;
};

type NativeDecode = {
  frames: DecodedFrame[];
  decodeFailure?: string;
  captureFailure?: string;
};

const MAX_FRAME_RGBA_BYTES = 16 * 1024 * 1024;

function errorDescription(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function captureFrame(frame: VideoFrame): Promise<DecodedFrame> {
  try {
    const size = frame.displayWidth * frame.displayHeight * 4;
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FRAME_RGBA_BYTES) {
      throw new Error(`Native RGBA frame exceeds test budget: ${size}`);
    }
    let rgba: Uint8Array;
    try {
      const layoutSize = frame.allocationSize({ format: 'RGBA' });
      if (
        !Number.isSafeInteger(layoutSize) ||
        layoutSize <= 0 ||
        layoutSize > MAX_FRAME_RGBA_BYTES
      ) {
        throw new Error(`Native RGBA layout exceeds test budget: ${layoutSize}`);
      }
      rgba = new Uint8Array(layoutSize);
      await frame.copyTo(rgba, { format: 'RGBA' });
    } catch (error) {
      // Managed WebKit decodes some frames but rejects their RGBA copyTo conversion.
      if (!(error instanceof TypeError)) throw error;
      const canvas = document.createElement('canvas');
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Native frame Canvas fallback is unavailable');
      context.drawImage(frame, 0, 0);
      rgba = new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
    }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(rgba)));
    const rect = frame.visibleRect;
    if (!rect) throw new Error('Native frame has no visible rectangle');
    return {
      timestamp: frame.timestamp,
      codedWidth: frame.codedWidth,
      codedHeight: frame.codedHeight,
      visibleRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      displayWidth: frame.displayWidth,
      displayHeight: frame.displayHeight,
      rgbaSha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  } finally {
    frame.close();
  }
}

/** Decode one independently sourced packet stream with a fresh native decoder. */
async function decodeNative(
  config: VideoDecoderConfig,
  chunks: EncodedVideoChunk[]
): Promise<NativeDecode> {
  const pending: Promise<{ frame?: DecodedFrame; failure?: string }>[] = [];
  let decodeFailure: string | undefined;
  let decoder: VideoDecoder | undefined;
  try {
    decoder = new VideoDecoder({
      output(frame) {
        // Every promise resolves, so an asynchronous copy failure cannot escape the callback.
        pending.push(
          captureFrame(frame).then(
            (value) => ({ frame: value }),
            (error: unknown) => ({ failure: errorDescription(error) })
          )
        );
      },
      error(error) {
        decodeFailure = errorDescription(error);
      },
    });
    decoder.configure(config);
    for (const chunk of chunks) decoder.decode(chunk);
    await decoder.flush();
  } catch (error) {
    decodeFailure ??= errorDescription(error);
  } finally {
    if (decoder?.state !== 'closed') decoder?.close();
  }
  const settled = await Promise.all(pending);
  const frames = settled.flatMap((result) => (result.frame ? [result.frame] : []));
  const copyFailure = settled.find((result) => result.failure)?.failure;
  return {
    frames,
    ...(decodeFailure ? { decodeFailure } : {}),
    ...(copyFailure ? { captureFailure: copyFailure } : {}),
  };
}

/** Actual compiled parser, metadata adapter and native decoder; no mocked WASM. */
describe('owned demux through browser WebCodecs', () => {
  for (const fixture of oracle.fixtures) {
    it(`decodes the admitted packet sequence: ${fixture.id}`, async (context) => {
      const raw = sources[`../../fixtures/owned-demux/${fixture.id}.base64`];
      if (typeof raw !== 'string') throw new Error('Missing source-bound demux fixture');
      const bytes = Uint8Array.from(atob(raw.trim()), (char) => char.charCodeAt(0));
      expect(bytes.byteLength).toBe(fixture.input.size);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')).toBe(
        fixture.input.sha256
      );
      const source = new Blob([bytes]);
      const metadata = await extractVideoMetadata(source);
      expect(metadata.duration).toBe(fixture.duration);
      expect(metadata.framerate).toBe(Math.round(fixture.stats.averagePacketRate * 100) / 100);
      expect(metadata.bitrate).toBe(Math.round(fixture.stats.averageBitrate));
      expect(metadata.rotation).toBe(fixture.rotation);
      const session = await createOwnedDemuxSession(source);
      const reference = createMediaBunnyInput(source);
      try {
        const track = await session.analyze();
        const config = ownedDecoderConfig(track);
        const referenceTrack = await reference.getPrimaryVideoTrack();
        if (!referenceTrack) throw new Error('Pinned reference has no primary video track');
        const referenceConfig = await referenceTrack.getDecoderConfig();
        if (!referenceConfig) throw new Error('Pinned reference has no native decoder config');
        if (typeof VideoDecoder === 'undefined') {
          context.skip('Native browser VideoDecoder is unavailable');
          return;
        }
        const [referenceSupport, ownedSupport] = await Promise.all([
          VideoDecoder.isConfigSupported(referenceConfig),
          VideoDecoder.isConfigSupported(config),
        ]);
        expect(ownedSupport.supported).toBe(referenceSupport.supported);
        if (!referenceSupport.supported) {
          context.skip(`Native browser decoder rejected both ${referenceConfig.codec} configs`);
          return;
        }
        const referenceChunks: EncodedVideoChunk[] = [];
        for await (const packet of new EncodedPacketSink(referenceTrack).packets()) {
          referenceChunks.push(packet.toEncodedVideoChunk());
        }
        expect(referenceChunks).toHaveLength(fixture.packets.length);
        const ownedChunks: EncodedVideoChunk[] = [];
        for (let index = 0; index < track.packetCount; index++) {
          const packet = await session.packetAsync(index);
          const data = await session.readPacket(packet);
          ownedChunks.push(
            new EncodedVideoChunk({
              type: packet.key ? 'key' : 'delta',
              timestamp: ownedTimestampUs(packet.ptsTicks, track.timescale),
              duration: ownedTimestampUs(packet.durationTicks, track.timescale),
              data,
            })
          );
        }
        const baseline = await decodeNative(referenceConfig, referenceChunks);
        const candidate = await decodeNative(config, ownedChunks);
        expect(baseline.captureFailure, 'Reference RGBA frame capture failed').toBeUndefined();
        expect(candidate.captureFailure, 'Owned RGBA frame capture failed').toBeUndefined();
        if (baseline.decodeFailure) {
          expect(
            candidate.decodeFailure,
            'Owned decode must match a reference native failure'
          ).toBe(baseline.decodeFailure);
          context.skip(`Native decoder rejected both streams: ${baseline.decodeFailure}`);
          return;
        }
        expect(candidate.decodeFailure).toBeUndefined();
        expect(baseline.frames.map((frame) => frame.timestamp)).toEqual(
          fixture.packets.map((packet) => packet.timestampUs).sort((a, b) => a - b)
        );
        expect(candidate.frames).toEqual(baseline.frames);
      } finally {
        reference.dispose();
        session.release();
      }
    });
  }
});
