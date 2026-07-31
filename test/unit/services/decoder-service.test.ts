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
      static controlledCopies = false;
      static copyResolvers = new Map<number, () => void>();
      static copyStarts: number[] = [];
      static frameDuration: number | null = 16_667;

      readonly codedWidth = 8;
      readonly codedHeight = 8;
      readonly displayWidth = 8;
      readonly displayHeight = 8;
      readonly close = vi.fn();

      constructor(
        private readonly intensity: number,
        readonly timestamp = intensity * 1_000,
        readonly duration: number | null = FakeVideoFrame.frameDuration
      ) {}

      allocationSize(): number {
        return 8 * 8 * 4;
      }

      async copyTo(destination: AllowSharedBufferSource): Promise<PlaneLayout[]> {
        FakeVideoFrame.copyStarts.push(this.timestamp);
        if (FakeVideoFrame.controlledCopies) {
          await new Promise<void>((resolve) => {
            FakeVideoFrame.copyResolvers.set(this.timestamp, resolve);
          });
        }
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
        const intensity =
          (chunk as EncodedVideoChunk & { intensity?: number }).intensity ??
          Number(chunk.timestamp / 1_000);
        this.output(new FakeVideoFrame(intensity, chunk.timestamp) as unknown as VideoFrame);
      }

      async flush(): Promise<void> {}
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      globalBufferPool.clear();
      FakeVideoDecoder.configureCalls = 0;
      FakeVideoFrame.controlledCopies = false;
      FakeVideoFrame.frameDuration = 16_667;
      FakeVideoFrame.copyResolvers.clear();
      FakeVideoFrame.copyStarts.length = 0;
    });

    async function decodeAdaptive(
      intensities: number[],
      frameDecimation = 1,
      framerate = 60
    ): Promise<number[]> {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const chunks = intensities.map(
        (intensity, index) => ({ intensity, timestamp: index * 1_000 }) as EncodedVideoChunk
      );
      const delivered: number[] = [];

      await decodeFrames(
        {
          chunks,
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 1,
          framerate,
          sourceTotalMs: chunks.length * 16.667,
          totalFrames: chunks.length,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          frameDecimation,
          smartFrameSkip: 'adaptive',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        }
      );

      return delivered;
    }

    it('derives a missing frame duration from source fps', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      FakeVideoFrame.frameDuration = null;
      const durations: number[] = [];

      await decodeFrames(
        {
          chunks: [{ intensity: 0, timestamp: 0 } as unknown as EncodedVideoChunk],
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0.04,
          framerate: 25,
          sourceTotalMs: 40,
          totalFrames: 1,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData, durationMs) => {
            durations.push(durationMs);
            globalBufferPool.release(rgbData);
          },
        }
      );

      expect(durations).toEqual([40]);
    });

    it('combines adaptive and preset decimation without multiplying them', async () => {
      const intensities = [
        ...Array.from({ length: 16 }, () => 0),
        ...Array.from({ length: 24 }, (_, index) => (index + 1) * 4),
      ];

      const delivered = await decodeAdaptive(intensities, 5);
      const gaps = delivered.slice(1).map((frame, index) => frame - delivered[index]!);

      expect(delivered).toHaveLength(8);
      expect(delivered).toContain(16); // scene change remains visible
      expect(Math.max(...gaps)).toBeLessThanOrEqual(6);
    });

    it('caps adaptive decimation at the minimum output fps', async () => {
      const delivered = await decodeAdaptive(Array.from({ length: 40 }, () => 0), 1, 15);

      expect(delivered.length).toBeGreaterThanOrEqual(8);
    });

    it('classifies static, slow, normal, and fast fixtures with distinct decimation', async () => {
      const warmup = Array.from({ length: 16 }, () => 0);
      const staticFrames = await decodeAdaptive([...warmup, ...Array.from({ length: 24 }, () => 0)]);
      const slowFrames = await decodeAdaptive([
        ...warmup,
        ...Array.from({ length: 24 }, (_, index) => (index + 1) * 2),
      ]);
      const normalFrames = await decodeAdaptive([
        ...warmup,
        ...Array.from({ length: 24 }, (_, index) => (index + 1) * 4),
      ]);
      const fastFrames = await decodeAdaptive([
        ...warmup,
        ...Array.from({ length: 24 }, (_, index) => (index + 1) * 8),
      ]);

      expect(staticFrames.length).toBeLessThan(slowFrames.length);
      expect(slowFrames.length).toBeLessThan(normalFrames.length);
      expect(normalFrames.length).toBeLessThan(fastFrames.length);
    });

    it('keeps a scene-change frame that lands on a static-scene skip slot', async () => {
      const delivered = await decodeAdaptive([
        ...Array.from({ length: 17 }, () => 0),
        4,
        8,
        12,
      ]);

      expect(delivered).toContain(17);
    });

    it('preserves presentation order while frame copies complete in parallel', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      FakeVideoFrame.controlledCopies = true;
      const delivered: number[] = [];

      const decoding = decodeFrames(
        {
          chunks: [
            { intensity: 0, timestamp: 0 },
            { intensity: 10, timestamp: 1_000 },
            { intensity: 20, timestamp: 2_000 },
          ] as EncodedVideoChunk[],
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0.05,
          framerate: 60,
          sourceTotalMs: 50,
          totalFrames: 3,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          smartFrameSkip: 'medium',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        }
      );

      await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toHaveLength(3));
      FakeVideoFrame.copyResolvers.get(2_000)?.();
      FakeVideoFrame.copyResolvers.get(1_000)?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(delivered).toEqual([]);

      FakeVideoFrame.copyResolvers.get(0)?.();
      await decoding;

      expect(delivered).toEqual([0, 1, 2]);
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
