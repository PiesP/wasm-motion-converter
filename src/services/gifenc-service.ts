import GIFEncoder, { applyPalette, quantize } from 'gifenc';
import { logger } from '../utils/logger';

export interface GifEncOptions {
  width: number;
  height: number;
  fps: number;
  colors: number;
  loop?: number;
  onProgress?: (current: number, total: number) => void;
  shouldCancel?: () => boolean;
}

export class GifEncService {
  static isSupported(): boolean {
    return typeof GIFEncoder === 'function';
  }

  static async encode(frames: ImageData[], options: GifEncOptions): Promise<Blob> {
    if (!frames.length) {
      throw new Error('No frames provided for GIF encoding.');
    }

    const { width, height, fps, colors, loop = 0, onProgress, shouldCancel } = options;
    const delay = Math.max(1, Math.round(1000 / fps));
    const gif = GIFEncoder({ auto: true });
    const startTime = performance.now();

    for (let index = 0; index < frames.length; index += 1) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      const frame = frames[index];
      if (!frame) {
        throw new Error(`Frame at index ${index} is undefined`);
      }
      const rgba = frame.data;
      const palette = quantize(rgba, colors);
      const indexed = applyPalette(rgba, palette);

      gif.writeFrame(indexed, width, height, {
        palette,
        delay,
        repeat: loop,
      });

      onProgress?.(index + 1, frames.length);
    }

    gif.finish();
    const gifBytes = gif.bytes();
    const duration = performance.now() - startTime;

    logger.info('conversion', 'gifenc encoding completed', {
      frameCount: frames.length,
      fileSize: gifBytes.length,
      duration: Math.round(duration),
      fps,
      colors,
    });

    // Convert to regular Uint8Array if needed to avoid SharedArrayBuffer issues
    const gifBytesArray =
      gifBytes instanceof Uint8Array && gifBytes.buffer instanceof ArrayBuffer
        ? gifBytes
        : new Uint8Array(gifBytes);

    // Ensure we have a regular ArrayBuffer, not SharedArrayBuffer
    let blobData: BlobPart;
    if (gifBytesArray.buffer instanceof ArrayBuffer) {
      blobData = gifBytesArray as unknown as Uint8Array<ArrayBuffer>;
    } else {
      const regularBuffer = new ArrayBuffer(gifBytesArray.length);
      new Uint8Array(regularBuffer).set(gifBytesArray);
      blobData = new Uint8Array(regularBuffer);
    }

    return new Blob([blobData], { type: 'image/gif' });
  }
}
