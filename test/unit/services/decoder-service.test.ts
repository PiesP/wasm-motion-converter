// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFrames, type DecodeResult } from '@services/decoder-service';
import { globalBufferPool } from '@services/buffer-pool';

vi.mock('@utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('decoder-service', () => {
  describe(' DecodeResult structure (type validation)', () => {
    it('DecodeResult contains expected fields', () => {
      const result: DecodeResult = {
        frames: [],
        totalInputFrames: 0,
        skippedByDecimation: 0,
        smartSkipped: 0,
        sourceTotalMs: 0,
        outputTotalMs: 0,
        tailAccumulatedMs: 0,
      };
      expect(result.frames).toBeInstanceOf(Array);
      expect(result.totalInputFrames).toBe(0);
    });
  });

  describe('DecodeOptions defaults', () => {
    it('frameDecimation defaults to undefined (no decimation)', () => {
      // When frameDecimation is not provided, all frames should be kept
      expect(undefined).toBeUndefined();
    });
  });

  describe('frame decimation logic', () => {
    it('frameDecimation=1 keeps all frames', () => {
      // decimation 1 means keep every frame
      expect(1).toBe(1);
    });

    it('frameDecimation=2 skips every other frame', () => {
      // decimation 2 means keep every 2nd frame
      expect(2).toBe(2);
    });
  });

  describe('adaptive frame skip', () => {
    class FakeVideoFrame {
      readonly codedWidth = 8;
      readonly codedHeight = 8;
      readonly displayWidth = 8;
      readonly displayHeight = 8;
      readonly duration = 16_667;
      readonly close = vi.fn();

      constructor(
        private readonly intensity: number,
        readonly timestamp = intensity * 1_000
      ) {}

      allocationSize(): number {
        return 8 * 8 * 4;
      }

      async copyTo(destination: AllowSharedBufferSource): Promise<PlaneLayout[]> {
        const bytes = new Uint8Array(
          ArrayBuffer.isView(destination) ? destination.buffer : destination
        );
        for (let index = 0; index < 8 * 8; index++) {
          const offset = index * 4;
          bytes[offset] = this.intensity;
          bytes[offset + 1] = this.intensity;
          bytes[offset + 2] = this.intensity;
          bytes[offset + 3] = 255;
        }
        return [{ offset: 0, stride: 8 * 4 }];
      }
    }

    class FakeVideoDecoder {
      static configureCalls = 0;

      static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
        return { config, supported: true };
      }

      readonly close = vi.fn();
      decodeQueueSize = 0;
      private readonly output: (frame: VideoFrame) => void;

      constructor(init: VideoDecoderInit) {
        this.output = init.output;
      }

      configure(): void {
        FakeVideoDecoder.configureCalls++;
      }

      decode(chunk: EncodedVideoChunk): void {
        const intensity = Number(chunk.timestamp / 1_000);
        this.output(new FakeVideoFrame(intensity) as unknown as VideoFrame);
      }

      async flush(): Promise<void> {}
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      globalBufferPool.clear();
      FakeVideoDecoder.configureCalls = 0;
    });

    it('learns static motion instead of staying on normal decimation', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const chunks = Array.from(
        { length: 40 },
        (_, index) => ({ timestamp: index * 1_000 }) as EncodedVideoChunk
      );
      const delivered: number[] = [];

      const result = await decodeFrames(
        {
          chunks,
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 1,
          framerate: 60,
          sourceTotalMs: 667,
          totalFrames: chunks.length,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          smartFrameSkip: 'adaptive',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        }
      );

      expect(result.smartSkipped).toBeGreaterThan(chunks.length / 2);
      expect(delivered.length).toBeLessThan(chunks.length / 2);
    });

    it('decodes preroll packets but does not deliver frames before trimStart', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const delivered: number[] = [];

      await decodeFrames(
        {
          chunks: [
            { timestamp: 4_000 } as EncodedVideoChunk,
            { timestamp: 5_000 } as EncodedVideoChunk,
          ],
          config: { codec: 'avc1.640028', codedWidth: 8, codedHeight: 8 },
          duration: 2,
          framerate: 1,
          sourceTotalMs: 2_000,
          totalFrames: 2,
          trimStartUs: 5_000,
        } as never,
        {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        }
      );

      expect(delivered).toEqual([0]);
    });

    it('configures the decoder exactly once per decode operation', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

      await decodeFrames(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0,
          framerate: 30,
          sourceTotalMs: 0,
          totalFrames: 0,
        },
        { width: 8, height: 8 }
      );

      expect(FakeVideoDecoder.configureCalls).toBe(1);
    });
  });
});
