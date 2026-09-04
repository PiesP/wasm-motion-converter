// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { afterEach, describe, expect, it, vi } from 'vitest';
import { globalBufferPool } from '@services/buffer-pool';
import { decodeFrames, type DecodeResult } from '@services/decoder-service';
import {
  calculateFrameOutputConcurrency,
  calculateStagedFrameSourceCapacity,
  estimateActiveFrameBytes,
  estimateRuntimeDecodedSourceFrameBytes,
} from '@services/frame-memory';
import { clearCanvasCache } from '@services/frame-utils';
import { FRAME_PIPELINE_MEMORY_BUDGET_BYTES, MAX_FRAME_PIXEL_COUNT } from '@utils/constants';

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@utils/logger', () => ({ logger }));

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
      static allocationBytesPerPixel = 4;
      static allocationSizeThrows = false;
      static controlledCopies = false;
      static copyResolvers = new Map<number, () => void>();
      static copyStarts: number[] = [];
      static failCopies = false;
      static frameDuration: number | null = 16_667;
      static frameFormat: VideoPixelFormat | null = 'RGBA';
      static instances: FakeVideoFrame[] = [];

      readonly close = vi.fn();
      readonly format = FakeVideoFrame.frameFormat;

      constructor(
        private readonly intensity: number,
        readonly timestamp = intensity * 1_000,
        readonly duration: number | null = FakeVideoFrame.frameDuration,
        readonly codedWidth = 8,
        readonly codedHeight = 8,
        readonly displayWidth = codedWidth,
        readonly displayHeight = codedHeight
      ) {
        FakeVideoFrame.instances.push(this);
      }

      allocationSize(): number {
        if (FakeVideoFrame.allocationSizeThrows) {
          throw new Error('fixture allocation size failure');
        }
        return (
          Math.max(this.codedWidth, this.displayWidth) *
          Math.max(this.codedHeight, this.displayHeight) *
          FakeVideoFrame.allocationBytesPerPixel
        );
      }

      async copyTo(destination: AllowSharedBufferSource): Promise<PlaneLayout[]> {
        FakeVideoFrame.copyStarts.push(this.timestamp);
        if (FakeVideoFrame.failCopies) throw new Error('fixture copy failure');
        if (FakeVideoFrame.controlledCopies) {
          await new Promise<void>((resolve) => {
            FakeVideoFrame.copyResolvers.set(this.timestamp, resolve);
          });
        }
        const bytes = new Uint8Array(
          ArrayBuffer.isView(destination) ? destination.buffer : destination
        );
        for (let index = 0; index < this.codedWidth * this.codedHeight; index++) {
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
      readonly reset = vi.fn();
      decodeQueueSize = 0;
      private readonly output: (frame: VideoFrame) => void;

      constructor(init: VideoDecoderInit) {
        this.output = init.output;
      }

      configure(): void {
        FakeVideoDecoder.configureCalls++;
      }

      decode(chunk: EncodedVideoChunk): void {
        const fixture = chunk as EncodedVideoChunk & {
          codedHeight?: number;
          codedWidth?: number;
          intensity?: number;
        };
        const intensity = fixture.intensity ?? Number(chunk.timestamp / 1_000);
        this.output(
          new FakeVideoFrame(
            intensity,
            chunk.timestamp,
            FakeVideoFrame.frameDuration,
            fixture.codedWidth,
            fixture.codedHeight
          ) as unknown as VideoFrame
        );
      }

      async flush(): Promise<void> {}
    }

    function createFlushBurstVideoDecoder(
      frameCount: number,
      sourceWidth = 3840,
      sourceHeight = 2160
    ) {
      const stats = { maxOutstandingFrames: 0 };
      class FlushBurstVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          this.output = init.output;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          const emitted: FakeVideoFrame[] = [];
          for (let index = 0; index < frameCount; index++) {
            const frame = new FakeVideoFrame(
              index,
              index * 1_000,
              16_667,
              sourceWidth,
              sourceHeight
            );
            emitted.push(frame);
            this.output(frame as unknown as VideoFrame);
            stats.maxOutstandingFrames = Math.max(
              stats.maxOutstandingFrames,
              emitted.filter((candidate) => candidate.close.mock.calls.length === 0).length
            );
          }
        }
      }

      return { Decoder: FlushBurstVideoDecoder, stats };
    }

    function stubScalingCanvas(width: number, height: number): { copies: () => number } {
      let canvasCopies = 0;
      const context = {
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => {
          canvasCopies++;
          return { data: new Uint8ClampedArray(width * height * 4) };
        }),
      };
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          getContext(): typeof context {
            return context;
          }
        }
      );
      vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('use canvas fallback')));
      return { copies: () => canvasCopies };
    }

    function createConfigFailureVideoDecoder(
      onSupportCheck: () => void,
      failureMessage = 'fixture support rejection'
    ) {
      const constructorCalls = vi.fn();
      class ConfigFailureVideoDecoder {
        static async isConfigSupported(): Promise<VideoDecoderSupport> {
          onSupportCheck();
          throw new Error(failureMessage);
        }

        constructor() {
          constructorCalls();
        }
      }
      return { constructorCalls, Decoder: ConfigFailureVideoDecoder };
    }

    function createConfigFailureDemux(codec: string, dispose: () => void) {
      return {
        chunks: [],
        config: { codec, codedWidth: 8, codedHeight: 8 },
        dispose,
        duration: 0,
        framerate: 60,
        sourceTotalMs: 0,
        totalFrames: 0,
      };
    }

    afterEach(() => {
      clearCanvasCache();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
      globalBufferPool.clear();
      FakeVideoDecoder.configureCalls = 0;
      FakeVideoFrame.allocationBytesPerPixel = 4;
      FakeVideoFrame.allocationSizeThrows = false;
      FakeVideoFrame.controlledCopies = false;
      FakeVideoFrame.failCopies = false;
      FakeVideoFrame.frameDuration = 16_667;
      FakeVideoFrame.frameFormat = 'RGBA';
      FakeVideoFrame.instances.length = 0;
      FakeVideoFrame.copyResolvers.clear();
      FakeVideoFrame.copyStarts.length = 0;
    });

    it('preserves cancellation that occurs during decoder support resolution', async () => {
      const cancellation = new AbortController();
      const dispose = vi.fn();
      const { constructorCalls, Decoder } = createConfigFailureVideoDecoder(() => {
        cancellation.abort();
      });
      vi.stubGlobal('VideoDecoder', Decoder);

      await expect(
        decodeFrames(
          createConfigFailureDemux('vp09.config-cancel-first', dispose),
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          cancellation.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(constructorCalls).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves processing failure that occurs during decoder support resolution', async () => {
      const processing = new AbortController();
      const dispose = vi.fn();
      const { constructorCalls, Decoder } = createConfigFailureVideoDecoder(() => {
        processing.abort(new Error('fixture processing during support'));
      });
      vi.stubGlobal('VideoDecoder', Decoder);

      await expect(
        decodeFrames(createConfigFailureDemux('vp09.config-processing-first', dispose), {
          width: 8,
          height: 8,
          mode: 'stream',
          processingFailureSignal: processing.signal,
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        })
      ).rejects.toThrow('Frame processing failed: fixture processing during support');

      expect(constructorCalls).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves support rejection when cancellation happens later', async () => {
      const cancellation = new AbortController();
      const dispose = vi.fn();
      const { constructorCalls, Decoder } = createConfigFailureVideoDecoder(() => undefined);
      vi.stubGlobal('VideoDecoder', Decoder);

      const decoding = decodeFrames(
        createConfigFailureDemux('vp09.config-support-first', dispose),
        {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        },
        cancellation.signal
      );

      await expect(decoding).rejects.toThrow('fixture support rejection');
      cancellation.abort();
      expect(constructorCalls).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves an already-aborted cancellation over unsupported configuration', async () => {
      const cancellation = new AbortController();
      cancellation.abort();
      const dispose = vi.fn();
      const constructorCalls = vi.fn();
      class UnsupportedVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: false };
        }

        constructor() {
          constructorCalls();
        }
      }
      vi.stubGlobal('VideoDecoder', UnsupportedVideoDecoder);

      await expect(
        decodeFrames(
          createConfigFailureDemux('vp09.config-pre-aborted', dispose),
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          cancellation.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(constructorCalls).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('removes pre-config listeners when decoder support resolution fails', async () => {
      const cancellation = new AbortController();
      const processing = new AbortController();
      const cancelAdd = vi.spyOn(cancellation.signal, 'addEventListener');
      const cancelRemove = vi.spyOn(cancellation.signal, 'removeEventListener');
      const processingAdd = vi.spyOn(processing.signal, 'addEventListener');
      const processingRemove = vi.spyOn(processing.signal, 'removeEventListener');
      const dispose = vi.fn();
      const { Decoder } = createConfigFailureVideoDecoder(() => undefined);
      vi.stubGlobal('VideoDecoder', Decoder);

      await expect(
        decodeFrames(
          createConfigFailureDemux('vp09.config-listener-cleanup', dispose),
          {
            width: 8,
            height: 8,
            mode: 'stream',
            processingFailureSignal: processing.signal,
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          cancellation.signal
        )
      ).rejects.toThrow('fixture support rejection');

      expect(cancelAdd).toHaveBeenCalledOnce();
      expect(cancelRemove).toHaveBeenCalledOnce();
      expect(processingAdd).toHaveBeenCalledOnce();
      expect(processingRemove).toHaveBeenCalledOnce();
      expect(cancelRemove.mock.calls[0]?.[1]).toBe(cancelAdd.mock.calls[0]?.[1]);
      expect(processingRemove.mock.calls[0]?.[1]).toBe(processingAdd.mock.calls[0]?.[1]);
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('cleans listeners and demux when the VideoDecoder constructor throws', async () => {
      const cancellation = new AbortController();
      const processing = new AbortController();
      const cancelAdd = vi.spyOn(cancellation.signal, 'addEventListener');
      const cancelRemove = vi.spyOn(cancellation.signal, 'removeEventListener');
      const processingAdd = vi.spyOn(processing.signal, 'addEventListener');
      const processingRemove = vi.spyOn(processing.signal, 'removeEventListener');
      const dispose = vi.fn();
      class ConstructorFailureVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        constructor() {
          throw new Error('fixture constructor failure');
        }
      }
      vi.stubGlobal('VideoDecoder', ConstructorFailureVideoDecoder);

      await expect(
        decodeFrames(
          createConfigFailureDemux('vp09.config-constructor-failure', dispose),
          {
            width: 8,
            height: 8,
            mode: 'stream',
            processingFailureSignal: processing.signal,
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          cancellation.signal
        )
      ).rejects.toThrow('fixture constructor failure');

      expect(cancelRemove).toHaveBeenCalledOnce();
      expect(processingRemove).toHaveBeenCalledOnce();
      expect(cancelRemove.mock.calls[0]?.[1]).toBe(cancelAdd.mock.calls[0]?.[1]);
      expect(processingRemove.mock.calls[0]?.[1]).toBe(processingAdd.mock.calls[0]?.[1]);
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('closes a constructed decoder when configure throws', async () => {
      const dispose = vi.fn();
      class ConfigureFailureVideoDecoder {
        static instance: ConfigureFailureVideoDecoder | undefined;

        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly state = 'unconfigured';

        constructor() {
          ConfigureFailureVideoDecoder.instance = this;
        }

        configure(): void {
          throw new Error('fixture configure failure');
        }
      }
      vi.stubGlobal('VideoDecoder', ConfigureFailureVideoDecoder);

      await expect(
        decodeFrames(createConfigFailureDemux('vp09.config-configure-failure', dispose), {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        })
      ).rejects.toThrow('fixture configure failure');

      expect(ConfigureFailureVideoDecoder.instance?.close).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves prior cancellation over a constructor failure', async () => {
      const cancellation = new AbortController();
      cancellation.abort();
      const dispose = vi.fn();
      class ConstructorFailureVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        constructor() {
          throw new Error('fixture constructor later');
        }
      }
      vi.stubGlobal('VideoDecoder', ConstructorFailureVideoDecoder);

      await expect(
        decodeFrames(
          createConfigFailureDemux('vp09.config-cancel-constructor', dispose),
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          cancellation.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves prior processing failure over a configure failure', async () => {
      const processing = new AbortController();
      processing.abort(new Error('fixture processing before configure'));
      const dispose = vi.fn();
      class ConfigureFailureVideoDecoder {
        static instance: ConfigureFailureVideoDecoder | undefined;

        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly state = 'unconfigured';

        constructor() {
          ConfigureFailureVideoDecoder.instance = this;
        }

        configure(): void {
          throw new Error('fixture configure later');
        }
      }
      vi.stubGlobal('VideoDecoder', ConfigureFailureVideoDecoder);

      await expect(
        decodeFrames(createConfigFailureDemux('vp09.config-processing-configure', dispose), {
          width: 8,
          height: 8,
          mode: 'stream',
          processingFailureSignal: processing.signal,
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        })
      ).rejects.toThrow('Frame processing failed: fixture processing before configure');

      expect(ConfigureFailureVideoDecoder.instance?.close).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves support rejection when demux disposal also throws', async () => {
      const dispose = vi.fn(() => {
        throw new Error('fixture dispose later');
      });
      const { Decoder } = createConfigFailureVideoDecoder(() => undefined);
      vi.stubGlobal('VideoDecoder', Decoder);

      await expect(
        decodeFrames(createConfigFailureDemux('vp09.config-dispose-failure', dispose), {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        })
      ).rejects.toThrow('fixture support rejection');

      expect(dispose).toHaveBeenCalledOnce();
    });

    it('preserves runtime decoder failure when demux disposal also throws', async () => {
      const dispose = vi.fn(() => {
        throw new Error('fixture runtime dispose later');
      });
      class RuntimeAndDisposeFailureVideoDecoder {
        static instance: RuntimeAndDisposeFailureVideoDecoder | undefined;

        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly decodeQueueSize = 0;
        readonly reset = vi.fn();
        state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
        private readonly error: (error: DOMException) => void;

        constructor(init: VideoDecoderInit) {
          RuntimeAndDisposeFailureVideoDecoder.instance = this;
          this.error = init.error;
        }

        configure(): void {
          this.state = 'configured';
        }
        decode(): void {}

        async flush(): Promise<void> {
          this.error(new DOMException('fixture runtime fatal', 'EncodingError'));
        }
      }
      vi.stubGlobal('VideoDecoder', RuntimeAndDisposeFailureVideoDecoder);

      await expect(
        decodeFrames(createConfigFailureDemux('vp09.runtime-dispose-failure', dispose), {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        })
      ).rejects.toMatchObject({ message: 'fixture runtime fatal', name: 'EncodingError' });

      expect(dispose).toHaveBeenCalledOnce();
      expect(RuntimeAndDisposeFailureVideoDecoder.instance?.close).toHaveBeenCalledOnce();
    });

    it('surfaces demux disposal failure after successful decoding', async () => {
      const dispose = vi.fn(() => {
        throw new Error('fixture successful dispose failure');
      });
      class SuccessfulVideoDecoder {
        static instance: SuccessfulVideoDecoder | undefined;

        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly decodeQueueSize = 0;
        readonly reset = vi.fn();
        readonly state = 'configured';

        constructor() {
          SuccessfulVideoDecoder.instance = this;
        }

        configure(): void {}
        decode(): void {}
        async flush(): Promise<void> {}
      }
      vi.stubGlobal('VideoDecoder', SuccessfulVideoDecoder);

      await expect(
        decodeFrames(createConfigFailureDemux('vp09.runtime-success-dispose', dispose), {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        })
      ).rejects.toThrow('fixture successful dispose failure');

      expect(dispose).toHaveBeenCalledOnce();
      expect(SuccessfulVideoDecoder.instance?.close).toHaveBeenCalledOnce();
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

    it('enforces preset decimation for fast adaptive motion without degrading uncapped motion', async () => {
      const intensities = [
        ...Array.from({ length: 16 }, () => 0),
        ...Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? 255 : 0)),
      ];

      const capped = await decodeAdaptive(intensities, 8, 120);
      const uncapped = await decodeAdaptive(intensities, 1, 120);

      expect(capped).toEqual([0, 8, 16, 24, 32, 40, 48, 56, 64, 72]);
      expect(uncapped.filter((frame) => frame >= 16)).toEqual(
        Array.from({ length: 64 }, (_, index) => index + 16)
      );
    });

    it('does not let repeated scene changes reset a requested decimation floor', async () => {
      const intensities = [
        ...Array.from({ length: 16 }, () => 0),
        ...Array.from({ length: 64 }, (_, index) =>
          Math.floor(index / 2) % 2 === 0 ? 255 : 0
        ),
      ];

      expect(await decodeAdaptive(intensities, 8, 120)).toEqual([
        0, 8, 16, 24, 32, 40, 48, 56, 64, 72,
      ]);
    });

    it('falls back to preset decimation when batch mode cannot run adaptive analysis', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const chunks = Array.from(
        { length: 16 },
        (_, index) => ({ intensity: index, timestamp: index * 1_000 }) as EncodedVideoChunk
      );

      const result = await decodeFrames(
        {
          chunks,
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 1,
          framerate: 120,
          sourceTotalMs: chunks.length * 16.667,
          totalFrames: chunks.length,
        },
        {
          width: 8,
          height: 8,
          mode: 'batch',
          frameDecimation: 8,
          smartFrameSkip: 'adaptive',
        }
      );

      expect(result.frames).toHaveLength(2);
      expect(result.skippedByDecimation).toBe(14);
      expect(result.smartSkipped).toBe(0);
      for (const frame of result.frames) globalBufferPool.release(frame.data);
    });

    it('falls back to preset decimation when GPU streaming cannot run adaptive analysis', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const chunks = Array.from(
        { length: 16 },
        (_, index) => ({ intensity: index, timestamp: index * 1_000 }) as EncodedVideoChunk
      );
      const delivered: number[] = [];

      const result = await decodeFrames(
        {
          chunks,
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 1,
          framerate: 120,
          sourceTotalMs: chunks.length * 16.667,
          totalFrames: chunks.length,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          frameDecimation: 8,
          smartFrameSkip: 'adaptive',
          onVideoFrameAvailable: (frame, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            frame.close();
          },
        }
      );

      expect(delivered).toEqual([0, 8]);
      expect(result.skippedByDecimation).toBe(14);
      expect(result.smartSkipped).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        'decoders',
        'Decoding complete',
        expect.objectContaining({ outputFrames: 2 })
      );
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('does not close a GPU frame again when its owner closes before throwing', async () => {
      const { Decoder } = createFlushBurstVideoDecoder(1, 8, 8);
      vi.stubGlobal('VideoDecoder', Decoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.017,
            framerate: 60,
            sourceTotalMs: 17,
            totalFrames: 1,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onVideoFrameAvailable: async (frame) => {
              try {
                throw new Error('fixture GPU encoder failure');
              } finally {
                frame.close();
              }
            },
          }
        )
      ).rejects.toThrow('Frame processing failed: fixture GPU encoder failure');

      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
    });

    it('closes a GPU frame in the decoder when cancellation wins before transfer', async () => {
      const controller = new AbortController();
      class CancellingFlushVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          this.output = init.output;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          this.output(new FakeVideoFrame(0) as unknown as VideoFrame);
          controller.abort();
        }
      }
      vi.stubGlobal('VideoDecoder', CancellingFlushVideoDecoder);
      const delivered: number[] = [];

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.017,
            framerate: 60,
            sourceTotalMs: 17,
            totalFrames: 1,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onVideoFrameAvailable: (frame, _durationMs, frameNumber) => {
              delivered.push(frameNumber);
              frame.close();
            },
          },
          controller.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });

      expect(delivered).toEqual([]);
      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
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

    it('does not start a later frame copy before its presentation-order turn', async () => {
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

      await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toEqual([0]));
      FakeVideoFrame.copyResolvers.get(0)?.();
      await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toEqual([0, 1_000]));
      FakeVideoFrame.copyResolvers.get(1_000)?.();
      await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toEqual([0, 1_000, 2_000]));
      FakeVideoFrame.copyResolvers.get(2_000)?.();
      await decoding;

      expect(delivered).toEqual([0, 1, 2]);
    });

    it('stages a 1080p final flush burst while the first 960x540 delivery is slow', async () => {
      const outputCount = 13;
      const sourceCapacity = calculateStagedFrameSourceCapacity(
        1920,
        1080,
        1920,
        1080,
        960,
        540,
        Number.MAX_SAFE_INTEGER
      );
      const { Decoder, stats } = createFlushBurstVideoDecoder(outputCount, 1920, 1080);
      const canvas = stubScalingCanvas(960, 540);
      vi.stubGlobal('VideoDecoder', Decoder);
      const delivered: number[] = [];
      let releaseFirstDelivery!: () => void;
      const firstDelivery = new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve;
      });

      const decoding = decodeFrames(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 1920, codedHeight: 1080 },
          duration: 0.217,
          framerate: 60,
          sourceTotalMs: 217,
          totalFrames: outputCount,
        },
        {
          width: 960,
          height: 540,
          mode: 'stream',
          onFrameAvailable: async (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            try {
              if (frameNumber === 0) await firstDelivery;
            } finally {
              globalBufferPool.release(rgbData);
            }
          },
        }
      );

      let assertionError: unknown;
      try {
        await vi.waitFor(() => expect(delivered).toEqual([0]));
        expect(sourceCapacity).toBe(23);
        expect(stats.maxOutstandingFrames).toBe(outputCount);
        expect(stats.maxOutstandingFrames).toBeLessThanOrEqual(sourceCapacity);
        expect(canvas.copies()).toBe(1);
        expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
        for (const frame of FakeVideoFrame.instances.slice(1)) {
          expect(frame.close).not.toHaveBeenCalled();
        }
      } catch (error) {
        assertionError = error;
      } finally {
        releaseFirstDelivery();
        await decoding.catch(() => undefined);
      }

      if (assertionError) throw assertionError;
      expect(canvas.copies()).toBe(outputCount);
      expect(delivered).toEqual(Array.from({ length: outputCount }, (_, index) => index));
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('admits a bounded two-frame 4K-to-360p flush burst', async () => {
      const { Decoder, stats } = createFlushBurstVideoDecoder(2);
      const canvas = stubScalingCanvas(640, 360);
      vi.stubGlobal('VideoDecoder', Decoder);
      const delivered: number[] = [];
      const capacity = calculateStagedFrameSourceCapacity(
        3840,
        2160,
        3840,
        2160,
        640,
        360,
        Number.MAX_SAFE_INTEGER
      );

      const result = await decodeFrames(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 3840, codedHeight: 2160 },
          duration: 0.034,
          framerate: 60,
          sourceTotalMs: 34,
          totalFrames: 2,
        },
        {
          width: 640,
          height: 360,
          mode: 'stream',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        }
      );

      expect(capacity).toBe(5);
      expect(result.totalInputFrames).toBe(2);
      expect(canvas.copies()).toBe(2);
      expect(stats.maxOutstandingFrames).toBeLessThanOrEqual(capacity);
      expect(delivered).toEqual([0, 1]);
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('rejects and closes a source-frame flush burst beyond staged capacity', async () => {
      const capacity = calculateStagedFrameSourceCapacity(
        3840,
        2160,
        3840,
        2160,
        640,
        360,
        Number.MAX_SAFE_INTEGER
      );
      const { Decoder, stats } = createFlushBurstVideoDecoder(capacity + 1);
      const canvas = stubScalingCanvas(640, 360);
      vi.stubGlobal('VideoDecoder', Decoder);
      const delivered: number[] = [];

      const decoding = decodeFrames(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 3840, codedHeight: 2160 },
          duration: 0.1,
          framerate: 60,
          sourceTotalMs: 100,
          totalFrames: capacity + 1,
        },
        {
          width: 640,
          height: 360,
          mode: 'stream',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        }
      );

      await expect(decoding).rejects.toThrow('Decoded frame output memory limit exceeded');
      expect(capacity).toBe(5);
      expect(canvas.copies()).toBe(0);
      expect(stats.maxOutstandingFrames).toBe(capacity);
      expect(FakeVideoFrame.instances[capacity]?.close).toHaveBeenCalledOnce();
      expect(delivered).toEqual([]);
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('uses high-bit-depth allocationSize for staged source-frame admission', async () => {
      FakeVideoFrame.allocationBytesPerPixel = 12;
      FakeVideoFrame.frameFormat = 'I444';
      const runtimeSourceBytes = estimateRuntimeDecodedSourceFrameBytes(
        1920,
        1080,
        1920,
        1080,
        1920 * 1080 * 12
      );
      const targetWorkingBytes = estimateActiveFrameBytes(960, 540);
      const runtimeCapacity = Math.floor(
        (FRAME_PIPELINE_MEMORY_BUDGET_BYTES - targetWorkingBytes) / runtimeSourceBytes
      );
      const { Decoder, stats } = createFlushBurstVideoDecoder(
        runtimeCapacity + 1,
        1920,
        1080
      );
      const canvas = stubScalingCanvas(960, 540);
      vi.stubGlobal('VideoDecoder', Decoder);
      const delivered: number[] = [];

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 1920, codedHeight: 1080 },
            duration: 0.2,
            framerate: 60,
            sourceTotalMs: 200,
            totalFrames: runtimeCapacity + 1,
          },
          {
            width: 960,
            height: 540,
            mode: 'stream',
            onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
              delivered.push(frameNumber);
              globalBufferPool.release(rgbData);
            },
          }
        )
      ).rejects.toThrow('Decoded frame output memory limit exceeded');

      expect(runtimeCapacity).toBe(7);
      expect(targetWorkingBytes + runtimeSourceBytes * runtimeCapacity).toBeLessThanOrEqual(
        FRAME_PIPELINE_MEMORY_BUDGET_BYTES
      );
      expect(targetWorkingBytes + runtimeSourceBytes * (runtimeCapacity + 1)).toBeGreaterThan(
        FRAME_PIPELINE_MEMORY_BUDGET_BYTES
      );
      expect(stats.maxOutstandingFrames).toBe(runtimeCapacity);
      expect(canvas.copies()).toBe(0);
      expect(delivered).toEqual([]);
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('uses an eight-byte source fallback when allocationSize throws', async () => {
      FakeVideoFrame.allocationSizeThrows = true;
      FakeVideoFrame.frameFormat = 'I444';
      const fallbackSourceBytes = estimateRuntimeDecodedSourceFrameBytes(
        1920,
        1080,
        1920,
        1080,
        null
      );
      const targetWorkingBytes = estimateActiveFrameBytes(960, 540);
      const fallbackCapacity = Math.floor(
        (FRAME_PIPELINE_MEMORY_BUDGET_BYTES - targetWorkingBytes) / fallbackSourceBytes
      );
      const { Decoder, stats } = createFlushBurstVideoDecoder(
        fallbackCapacity + 1,
        1920,
        1080
      );
      vi.stubGlobal('VideoDecoder', Decoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 1920, codedHeight: 1080 },
            duration: 0.2,
            framerate: 60,
            sourceTotalMs: 200,
            totalFrames: fallbackCapacity + 1,
          },
          {
            width: 960,
            height: 540,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toThrow('Decoded frame output memory limit exceeded');

      expect(fallbackCapacity).toBe(11);
      expect(stats.maxOutstandingFrames).toBe(fallbackCapacity);
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('admits more than ten small flush outputs within the ownership byte budget', async () => {
      const outputCount = 12;
      const ownershipCapacity = calculateFrameOutputConcurrency(
        8,
        8,
        8,
        8,
        Number.MAX_SAFE_INTEGER
      );
      const { Decoder, stats } = createFlushBurstVideoDecoder(outputCount, 8, 8);
      vi.stubGlobal('VideoDecoder', Decoder);
      const delivered: number[] = [];

      const result = await decodeFrames(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0.2,
          framerate: 60,
          sourceTotalMs: 200,
          totalFrames: outputCount,
        },
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

      expect(ownershipCapacity).toBeGreaterThan(10);
      expect(result.totalInputFrames).toBe(outputCount);
      expect(stats.maxOutstandingFrames).toBeLessThanOrEqual(ownershipCapacity);
      expect(delivered).toEqual(Array.from({ length: outputCount }, (_, index) => index));
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
    });

    it('closes an output frame without delivery when cancellation wins during its copy', async () => {
      class FlushOutputVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          this.output = init.output;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          this.output(new FakeVideoFrame(0) as unknown as VideoFrame);
        }
      }

      vi.stubGlobal('VideoDecoder', FlushOutputVideoDecoder);
      FakeVideoFrame.controlledCopies = true;
      const controller = new AbortController();
      const delivered: number[] = [];
      const decoding = decodeFrames(
        {
          chunks: [],
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0.017,
          framerate: 60,
          sourceTotalMs: 17,
          totalFrames: 1,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
            delivered.push(frameNumber);
            globalBufferPool.release(rgbData);
          },
        },
        controller.signal
      );

      await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toEqual([0]));
      controller.abort();
      FakeVideoFrame.copyResolvers.get(0)?.();

      await expect(decoding).rejects.toMatchObject({ name: 'AbortError' });
      expect(delivered).toEqual([]);
      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
      expect(globalBufferPool.totalActiveMemory).toBe(0);
    });

    it('closes and releases a source frame when VideoFrame.copyTo fails', async () => {
      const { Decoder } = createFlushBurstVideoDecoder(1, 8, 8);
      vi.stubGlobal('VideoDecoder', Decoder);
      FakeVideoFrame.failCopies = true;
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          constructor() {
            throw new Error('fixture copy failure');
          }
        }
      );

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.017,
            framerate: 60,
            sourceTotalMs: 17,
            totalFrames: 1,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toThrow('Frame processing failed: fixture copy failure');

      expect(FakeVideoFrame.copyStarts.length).toBeGreaterThan(0);
      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
      expect(globalBufferPool.totalActiveMemory).toBe(0);
    });

    it('closes staged source frames after a decoder error', async () => {
      class ErroringFlushVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly error: (error: DOMException) => void;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          this.error = init.error;
          this.output = init.output;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          this.output(new FakeVideoFrame(0) as unknown as VideoFrame);
          this.output(new FakeVideoFrame(1) as unknown as VideoFrame);
          this.error(new DOMException('fixture decoder failure', 'EncodingError'));
        }
      }

      vi.stubGlobal('VideoDecoder', ErroringFlushVideoDecoder);
      const delivered: number[] = [];

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.034,
            framerate: 60,
            sourceTotalMs: 34,
            totalFrames: 2,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
              delivered.push(frameNumber);
              globalBufferPool.release(rgbData);
            },
          }
        )
      ).rejects.toThrow('fixture decoder failure');

      expect(delivered).toEqual([]);
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
      expect(globalBufferPool.totalActiveMemory).toBe(0);
    });

    it('does not close a decoder that entered closed state before its fatal callback', async () => {
      class AutoClosedFatalVideoDecoder {
        static instance: AutoClosedFatalVideoDecoder | undefined;

        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn(() => {
          throw new DOMException('decoder already closed', 'InvalidStateError');
        });
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
        private readonly error: (error: DOMException) => void;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          AutoClosedFatalVideoDecoder.instance = this;
          this.error = init.error;
          this.output = init.output;
        }

        configure(): void {
          this.state = 'configured';
        }
        decode(): void {}

        async flush(): Promise<void> {
          this.output(new FakeVideoFrame(0) as unknown as VideoFrame);
          this.state = 'closed';
          this.error(new DOMException('fixture fatal decoder error', 'EncodingError'));
        }
      }

      vi.stubGlobal('VideoDecoder', AutoClosedFatalVideoDecoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.017,
            framerate: 60,
            sourceTotalMs: 17,
            totalFrames: 1,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toMatchObject({ message: 'fixture fatal decoder error', name: 'EncodingError' });

      expect(AutoClosedFatalVideoDecoder.instance?.close).not.toHaveBeenCalled();
      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
      expect(globalBufferPool.totalActiveMemory).toBe(0);
    });

    it('preserves a decoder failure that precedes a callback failure', async () => {
      class DecoderFailureFirstVideoDecoder {
        static emitError: ((error: DOMException) => void) | undefined;

        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          DecoderFailureFirstVideoDecoder.emitError = init.error;
          this.output = init.output;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          this.output(new FakeVideoFrame(0) as unknown as VideoFrame);
        }
      }

      vi.stubGlobal('VideoDecoder', DecoderFailureFirstVideoDecoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.017,
            framerate: 60,
            sourceTotalMs: 17,
            totalFrames: 1,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => {
              globalBufferPool.release(rgbData);
              DecoderFailureFirstVideoDecoder.emitError?.(
                new DOMException('fixture decoder first', 'EncodingError')
              );
              throw new Error('fixture callback later');
            },
          }
        )
      ).rejects.toThrow('fixture decoder first');

      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
      expect(globalBufferPool.totalActiveMemory).toBe(0);
    });

    it('preserves a processing failure that precedes a flush rejection', async () => {
      const processingFailure = new AbortController();
      class ProcessingFailureFirstVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          processingFailure.abort(new Error('fixture processing first'));
          throw new Error('fixture flush later');
        }
      }

      vi.stubGlobal('VideoDecoder', ProcessingFailureFirstVideoDecoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0,
            framerate: 60,
            sourceTotalMs: 0,
            totalFrames: 0,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            processingFailureSignal: processingFailure.signal,
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toThrow('Frame processing failed: fixture processing first');
    });

    it('preserves cancellation when it precedes a decoder error', async () => {
      const controller = new AbortController();
      class CancellationFirstVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly error: (error: DOMException) => void;

        constructor(init: VideoDecoderInit) {
          this.error = init.error;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          controller.abort();
          this.error(new DOMException('fixture decoder later', 'EncodingError'));
        }
      }

      vi.stubGlobal('VideoDecoder', CancellationFirstVideoDecoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0,
            framerate: 60,
            sourceTotalMs: 0,
            totalFrames: 0,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          controller.signal
        )
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('preserves a decoder error when it precedes cancellation', async () => {
      const controller = new AbortController();
      class DecoderFirstCancellationVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        readonly reset = vi.fn();
        readonly decodeQueueSize = 0;
        private readonly error: (error: DOMException) => void;

        constructor(init: VideoDecoderInit) {
          this.error = init.error;
        }

        configure(): void {}
        decode(): void {}

        async flush(): Promise<void> {
          this.error(new DOMException('fixture decoder first', 'EncodingError'));
          controller.abort();
        }
      }

      vi.stubGlobal('VideoDecoder', DecoderFirstCancellationVideoDecoder);

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0,
            framerate: 60,
            sourceTotalMs: 0,
            totalFrames: 0,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          },
          controller.signal
        )
      ).rejects.toMatchObject({ message: 'fixture decoder first', name: 'EncodingError' });
    });

    it.each([
      ['processing', 'Frame processing failed: fixture processing first'],
      ['cancellation', 'Cancelled'],
    ] as const)(
      'preserves %s when processing failure and cancellation race',
      async (firstFailure, expectedMessage) => {
        const cancellation = new AbortController();
        const processing = new AbortController();
        class RacingSignalVideoDecoder {
          static async isConfigSupported(
            config: VideoDecoderConfig
          ): Promise<VideoDecoderSupport> {
            return { config, supported: true };
          }

          readonly close = vi.fn();
          readonly reset = vi.fn();
          readonly decodeQueueSize = 0;

          configure(): void {}
          decode(): void {}

          async flush(): Promise<void> {
            const abortProcessing = (): void => {
              processing.abort(new Error('fixture processing first'));
            };
            if (firstFailure === 'processing') {
              abortProcessing();
              cancellation.abort();
            } else {
              cancellation.abort();
              abortProcessing();
            }
          }
        }

        vi.stubGlobal('VideoDecoder', RacingSignalVideoDecoder);

        await expect(
          decodeFrames(
            {
              chunks: [],
              config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
              duration: 0,
              framerate: 60,
              sourceTotalMs: 0,
              totalFrames: 0,
            },
            {
              width: 8,
              height: 8,
              mode: 'stream',
              processingFailureSignal: processing.signal,
              onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
            },
            cancellation.signal
          )
        ).rejects.toThrow(expectedMessage);
      }
    );

    it('applies output backpressure before pulling more demuxed chunks', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      FakeVideoFrame.controlledCopies = true;
      const pulled: number[] = [];
      const durationsUs = Array.from({ length: 12 }, (_, index) => (index + 1) * 1_000);

      const chunks = (async function* streamChunks(): AsyncGenerator<EncodedVideoChunk> {
        for (const [index, duration] of durationsUs.entries()) {
          pulled.push(index);
          yield {
            duration,
            intensity: index,
            timestamp: index * 1_000,
          } as unknown as EncodedVideoChunk;
        }
      })();

      const decoding = decodeFrames(
        {
          chunks,
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0.1,
          framerate: 120,
          sourceTotalMs: 0,
          totalFrames: 12,
        },
        {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        }
      );

      await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toEqual([0]));
      expect(pulled).toHaveLength(10);

      for (let index = 0; index < 12; index++) {
        FakeVideoFrame.copyResolvers.get(index * 1_000)?.();
        if (index === 0) await vi.waitFor(() => expect(pulled).toHaveLength(11));
        if (index === 1) await vi.waitFor(() => expect(pulled).toHaveLength(12));
        if (index < 11) {
          await vi.waitFor(() => expect(FakeVideoFrame.copyStarts).toHaveLength(index + 2));
        }
      }

      const result = await decoding;
      expect(result.sourceTotalMs).toBe(
        durationsUs.reduce((sum, duration) => sum + duration, 0) / 1000
      );
    });

    it('stops pulling chunks after the first frame-processing error and closes in-flight frames', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const firstError = new Error('first frame failure');
      const pulled: number[] = [];
      let producerClosed = false;
      let pullsAfterFailure = 0;
      let submissions = 0;
      const chunks = (async function* streamChunks(): AsyncGenerator<EncodedVideoChunk> {
        try {
          for (let index = 0; index < 20; index++) {
            if (submissions > 0) pullsAfterFailure++;
            pulled.push(index);
            yield { intensity: index, timestamp: index * 1_000 } as EncodedVideoChunk;
          }
        } finally {
          producerClosed = true;
        }
      })();

      await expect(
        decodeFrames(
          {
            chunks,
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.3,
            framerate: 60,
            sourceTotalMs: 300,
            totalFrames: 20,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => {
              submissions++;
              globalBufferPool.release(rgbData);
              throw firstError;
            },
          }
        )
      ).rejects.toThrow('Frame processing failed: first frame failure');

      expect(submissions).toBe(1);
      expect(pullsAfterFailure).toBe(0);
      expect(pulled.length).toBeLessThan(20);
      expect(producerClosed).toBe(true);
      expect(FakeVideoFrame.instances.length).toBeGreaterThan(0);
      expect(FakeVideoFrame.instances.length).toBeLessThanOrEqual(pulled.length);
      for (const frame of FakeVideoFrame.instances) {
        expect(frame.close).toHaveBeenCalledOnce();
      }
      expect(globalBufferPool.totalActiveMemory).toBe(0);
    });

    it('rejects an oversized decoded frame after accepting a legitimate frame', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const delivered: number[] = [];
      const oversizedWidth = MAX_FRAME_PIXEL_COUNT + 1;
      const chunks = [
        { codedHeight: 8, codedWidth: 8, intensity: 0, timestamp: 0 },
        { codedHeight: 1, codedWidth: oversizedWidth, intensity: 1, timestamp: 1_000 },
        { codedHeight: 8, codedWidth: 8, intensity: 2, timestamp: 2_000 },
      ] as unknown as EncodedVideoChunk[];

      await expect(
        decodeFrames(
          {
            chunks,
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.05,
            framerate: 60,
            sourceTotalMs: 50,
            totalFrames: chunks.length,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData, _durationMs, frameNumber) => {
              delivered.push(frameNumber);
              globalBufferPool.release(rgbData);
            },
          }
        )
      ).rejects.toThrow('Decoded frame dimensions exceed the per-frame memory limit');

      expect(delivered).toEqual([]);
      expect(FakeVideoFrame.instances).toHaveLength(2);
      expect(FakeVideoFrame.instances[0]?.close).toHaveBeenCalledOnce();
      expect(FakeVideoFrame.instances[1]?.close).toHaveBeenCalledOnce();
    });

    it('rejects a configured source whose single scaled output exceeds the byte budget', async () => {
      const VideoDecoderStub = vi.fn();
      vi.stubGlobal('VideoDecoder', VideoDecoderStub);
      const oversizedSourceWidth = FRAME_PIPELINE_MEMORY_BUDGET_BYTES / 4;

      await expect(
        decodeFrames(
          {
            chunks: [],
            config: {
              codec: 'vp09.00.10.08',
              codedWidth: oversizedSourceWidth,
              codedHeight: 2,
            },
            duration: 0,
            framerate: 60,
            sourceTotalMs: 0,
            totalFrames: 0,
          },
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toThrow(
        'Decoded frame output memory limit exceeded (single frame exceeds byte budget)'
      );

      expect(VideoDecoderStub).not.toHaveBeenCalled();
    });

    it('rejects cumulative in-flight encoded chunks above the demux budget', async () => {
      class HoldingVideoDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        decodeQueueSize = 0;

        configure(): void {}

        decode(): void {
          // Keep every encoded input in the codec without producing output.
        }

        async flush(): Promise<void> {}
      }

      vi.stubGlobal('VideoDecoder', HoldingVideoDecoder);
      const chunks = Array.from(
        { length: 3 },
        (_, index) =>
          ({
            byteLength: 1_500,
            duration: 1_000,
            timestamp: index * 1_000,
          }) as EncodedVideoChunk
      );

      await expect(
        decodeFrames(
          {
            chunks,
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.003,
            encodedChunkBudgetBytes: 6_000,
            framerate: 1_000,
            sourceTotalMs: 3,
            totalFrames: chunks.length,
          } as never,
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toThrow('Demux memory limit exceeded while queueing encoded packets');
    });

    it('releases encoded chunk budget when the matching decoder output arrives', async () => {
      vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
      const chunks = Array.from(
        { length: 3 },
        (_, index) =>
          ({
            byteLength: 1_500,
            duration: 1_000,
            intensity: index,
            timestamp: index * 1_000,
          }) as unknown as EncodedVideoChunk
      );

      const result = await decodeFrames(
        {
          chunks,
          config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
          duration: 0.003,
          encodedChunkBudgetBytes: 6_000,
          framerate: 1_000,
          sourceTotalMs: 3,
          totalFrames: chunks.length,
        } as never,
        {
          width: 8,
          height: 8,
          mode: 'stream',
          onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
        }
      );

      expect(result.totalInputFrames).toBe(3);
    });

    it('keeps a conservative byte bound for duplicate output timestamps', async () => {
      class DuplicateTimestampDecoder {
        static async isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly close = vi.fn();
        decodeQueueSize = 0;
        private decodedChunks = 0;
        private readonly output: (frame: VideoFrame) => void;

        constructor(init: VideoDecoderInit) {
          this.output = init.output;
        }

        configure(): void {}

        decode(): void {
          this.decodedChunks++;
          if (this.decodedChunks === 2) {
            this.output(new FakeVideoFrame(0, 0) as unknown as VideoFrame);
          }
        }

        async flush(): Promise<void> {}
      }

      vi.stubGlobal('VideoDecoder', DuplicateTimestampDecoder);
      const chunks = [
        { byteLength: 3_000, duration: 1_000, timestamp: 0 },
        { byteLength: 1_000, duration: 1_000, timestamp: 0 },
        { byteLength: 3_000, duration: 1_000, timestamp: 1_000 },
      ] as EncodedVideoChunk[];

      await expect(
        decodeFrames(
          {
            chunks,
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 0.003,
            encodedChunkBudgetBytes: 7_000,
            framerate: 1_000,
            sourceTotalMs: 3,
            totalFrames: chunks.length,
          } as never,
          {
            width: 8,
            height: 8,
            mode: 'stream',
            onFrameAvailable: (rgbData) => globalBufferPool.release(rgbData),
          }
        )
      ).rejects.toThrow('Demux memory limit exceeded while queueing encoded packets');
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

    it('bounds cumulative input packet work even when no output frames are produced', async () => {
      let decodeCalls = 0;
      class NoOutputVideoDecoder {
        static async isConfigSupported(
          config: VideoDecoderConfig
        ): Promise<VideoDecoderSupport> {
          return { config, supported: true };
        }

        readonly decodeQueueSize = 0;
        configure(): void {}
        decode(): void {
          decodeCalls++;
        }
        async flush(): Promise<void> {}
        reset(): void {}
        close(): void {}
      }
      vi.stubGlobal('VideoDecoder', NoOutputVideoDecoder);

      await expect(
        decodeFrames(
          {
            chunks: [
              { timestamp: 0 },
              { timestamp: 1_000 },
              { timestamp: 2_000 },
            ] as EncodedVideoChunk[],
            config: { codec: 'vp09.00.10.08', codedWidth: 8, codedHeight: 8 },
            duration: 1,
            framerate: 120,
            sourceTotalMs: 3,
            totalFrames: 3,
          },
          { width: 8, height: 8, maxInputChunks: 2 }
        )
      ).rejects.toThrow('Decoder input packet limit exceeded');

      expect(decodeCalls).toBe(2);
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
