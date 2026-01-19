import { esmShModuleUrl } from 'virtual:cdn-deps';
import type { EncoderFrame } from '@services/encoders/encoder-interface-service';
import { convertFramesToImageData } from '@services/encoders/frame-converter-service';
import { logger } from '@utils/logger';

type ModernGifModule = typeof import('modern-gif');

let cachedEncode: ModernGifModule['encode'] | null = null;
let loadEncodePromise: Promise<ModernGifModule['encode']> | null = null;

async function getModernGifEncode(): Promise<ModernGifModule['encode']> {
  if (cachedEncode) {
    return cachedEncode;
  }

  if (loadEncodePromise) {
    return loadEncodePromise;
  }

  loadEncodePromise = (async () => {
    const url = esmShModuleUrl('modern-gif');

    // Ensure Vite does not try to pre-bundle/rewrite the CDN URL.
    const mod = (await import(/* @vite-ignore */ url)) as unknown as ModernGifModule;
    if (typeof mod.encode !== 'function') {
      throw new Error('modern-gif module loaded but encode() export is missing');
    }

    cachedEncode = mod.encode;
    return cachedEncode;
  })();

  return loadEncodePromise;
}

/**
 * Options for modern-gif encoding
 */
export interface ModernGifOptions {
  width: number;
  height: number;
  fps: number;
  quality: 'low' | 'medium' | 'high';
  timestamps?: number[];
  durationSeconds?: number;
  loop?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

/**
 * Quality to max colors mapping for GIF palette optimization
 * - high: 256 colors (full palette, best quality)
 * - medium: 128 colors (balanced)
 * - low: 64 colors (smallest file size)
 */
const QUALITY_TO_MAX_COLORS = { high: 256, medium: 128, low: 64 } as const;

/**
 * Check if modern-gif library is available and supported.
 *
 * @returns True if modern-gif encode function is available
 */
export function isModernGifSupported(): boolean {
  // Encode() is loaded lazily from CDN.
  // Keep this check cheap/sync: it only validates baseline browser primitives.
  return typeof Blob !== 'undefined' && typeof ImageData !== 'undefined';
}

/**
 * Encode frames into animated GIF using modern-gif.
 * Uses quality-based color palette optimization for optimal file size.
 *
 * Accepts VideoFrame, ImageBitmap, or ImageData. Automatically converts
 * GPU-resident frames to ImageData when needed.
 *
 * @param frames - Array of frames to encode (VideoFrame, ImageBitmap, or ImageData)
 * @param options - Encoding options (width, height, fps, quality, callbacks)
 * @returns Animated GIF as Blob
 * @throws Error if no frames provided or conversion cancelled
 */
export async function encodeModernGif(
  frames: EncoderFrame[],
  options: ModernGifOptions
): Promise<Blob> {
  if (!frames.length) {
    throw new Error('No frames provided for GIF encoding.');
  }

  const { width, height, fps, quality, timestamps, durationSeconds, onProgress, shouldCancel } =
    options;

  if (shouldCancel?.()) {
    throw new Error('Conversion cancelled by user');
  }

  // Use quality mapping constant for palette optimization
  const maxColors = QUALITY_TO_MAX_COLORS[quality];

  const startTime = performance.now();

  logger.info('conversion', 'Starting modern-gif encoding', {
    frameCount: frames.length,
    width,
    height,
    fps,
    maxColors,
    hasTimestamps: Boolean(timestamps && timestamps.length > 0),
    durationSeconds,
  });

  // Convert frames to ImageData if needed (VideoFrame/ImageBitmap → ImageData)
  const imageDataFrames = await convertFramesToImageData(
    frames,
    width,
    height,
    undefined, // Don't report conversion progress separately
    shouldCancel
  );

  const totalFrames = imageDataFrames.length;
  const maxBeforeEncode = Math.max(0, totalFrames - 1);
  const baseDelayMs = Math.max(10, Math.round(1000 / Math.max(1, fps)));

  const resolveTargetDurationMs = (): number | null => {
    if (!Number.isFinite(durationSeconds) || !durationSeconds || durationSeconds <= 0) {
      return null;
    }

    return Math.round(durationSeconds * 1000);
  };

  const resolveDelayMs = (index: number): number => {
    if (timestamps && timestamps.length >= totalFrames) {
      const current = timestamps[index];
      const next = timestamps[index + 1];

      if (current !== undefined && next !== undefined) {
        if (Number.isFinite(current) && Number.isFinite(next)) {
          const deltaMs = Math.round((next - current) * 1000);
          return Math.max(10, deltaMs);
        }
      }
    }

    return baseDelayMs;
  };

  const normalizeDelaysToTotal = (delays: number[], targetMs: number): number[] => {
    if (!delays.length) {
      return delays;
    }

    const normalized = delays.map((delay) => Math.max(10, Math.round(delay)));
    let currentTotal = normalized.reduce((sum, value) => sum + value, 0);
    let diff = targetMs - currentTotal;

    if (diff === 0) {
      return normalized;
    }

    const maxIterations = normalized.length * 4 + Math.min(10_000, Math.abs(diff));
    let iterations = 0;

    while (diff !== 0 && iterations < maxIterations) {
      iterations += 1;
      const direction = diff > 0 ? 1 : -1;
      let adjusted = false;

      for (let i = 0; i < normalized.length && diff !== 0; i += 1) {
        const nextValue = normalized[i]! + direction;
        if (nextValue < 10) {
          continue;
        }
        normalized[i] = nextValue;
        diff -= direction;
        adjusted = true;
      }

      if (!adjusted) {
        break;
      }
    }

    currentTotal = normalized.reduce((sum, value) => sum + value, 0);
    if (currentTotal !== targetMs) {
      logger.warn('conversion', 'Failed to perfectly align GIF delays to target duration', {
        targetTotalMs: targetMs,
        currentTotalMs: currentTotal,
        frameCount: normalized.length,
      });
    }

    return normalized;
  };

  const initialDelays = imageDataFrames.map((_, index) => resolveDelayMs(index));
  const targetDurationMs = resolveTargetDurationMs();
  const delays = targetDurationMs
    ? normalizeDelaysToTotal(initialDelays, targetDurationMs)
    : initialDelays;

  if (delays.length > 0) {
    const avgDelay = delays.reduce((sum, value) => sum + value, 0) / delays.length;
    logger.debug('conversion', 'Computed GIF frame delays', {
      frameCount: delays.length,
      avgDelayMs: avgDelay.toFixed(2),
      minDelayMs: Math.min(...delays),
      maxDelayMs: Math.max(...delays),
    });
  }

  // Convert ImageData frames to UnencodedFrame format
  const gifFrames = imageDataFrames.map((imageData, index) => {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    // Reserve the final progress step for after encode() completes.
    const progressCurrent = Math.min(index + 1, maxBeforeEncode);
    onProgress?.(progressCurrent, totalFrames);

    return {
      data: imageData.data,
      delay: delays[index] ?? baseDelayMs,
    };
  });

  // modern-gif does not expose granular progress during encode().
  // Emit a lightweight keepalive so external watchdog monitoring doesn't flag
  // a false stall during the encode step.
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cancelledDuringEncode = false;

  try {
    heartbeatTimer = setInterval(() => {
      if (shouldCancel?.()) {
        cancelledDuringEncode = true;
      }

      onProgress?.(maxBeforeEncode, totalFrames);
    }, 1_000);

    const encode = await getModernGifEncode();

    const blob = await encode({
      width,
      height,
      frames: gifFrames,
      maxColors,
      format: 'blob',
    });

    if (cancelledDuringEncode || shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    onProgress?.(totalFrames, totalFrames);

    const duration = performance.now() - startTime;

    logger.info('conversion', 'modern-gif encoding completed', {
      frameCount: frames.length,
      fileSize: blob.size,
      duration: Math.round(duration),
      fps,
      maxColors,
    });

    return blob;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}
