// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { ownedDecoderConfig, ownedTimestampUs } from '@services/owned-demux-config';
import { createOwnedDemuxSession } from '@services/owned-demux-core';
import { extractVideoMetadata } from '@services/video-metadata';
import { describe, expect, it } from 'vite-plus/test';

import oracle from '../../fixtures/owned-demux/oracle.json';

const sources = import.meta.glob('../../fixtures/owned-demux/*.base64', {
  eager: true,
  query: '?raw',
  import: 'default',
});

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
      let decoder: VideoDecoder | undefined;
      try {
        const track = await session.analyze();
        const config = ownedDecoderConfig(track);
        if (typeof VideoDecoder === 'undefined') {
          context.skip('Native browser VideoDecoder is unavailable');
          return;
        }
        const supported = await VideoDecoder.isConfigSupported(config);
        if (!supported.supported) {
          context.skip(`Native browser decoder rejected ${config.codec}`);
          return;
        }
        const timestamps: number[] = [];
        let decodeError: DOMException | undefined;
        decoder = new VideoDecoder({
          output(frame) {
            try {
              expect(frame.visibleRect?.width).toBe(track.width);
              expect(frame.visibleRect?.height).toBe(track.height);
              timestamps.push(frame.timestamp);
            } finally {
              frame.close();
            }
          },
          error(error) {
            decodeError = error;
          },
        });
        decoder.configure(config);
        for (let index = 0; index < track.packetCount; index++) {
          const packet = session.packet(index);
          const data = await session.readPacket(packet);
          decoder.decode(
            new EncodedVideoChunk({
              type: packet.key ? 'key' : 'delta',
              timestamp: ownedTimestampUs(packet.ptsTicks, track.timescale),
              duration: ownedTimestampUs(packet.durationTicks, track.timescale),
              data,
            })
          );
        }
        await decoder.flush();
        if (decodeError) throw decodeError;
        expect(timestamps).toEqual(
          fixture.packets.map((packet) => packet.timestampUs).sort((a, b) => a - b)
        );
      } finally {
        if (decoder?.state !== 'closed') decoder?.close();
        session.release();
      }
    });
  }
});
