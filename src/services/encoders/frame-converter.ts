/**
 * Frame Format Conversion Utilities
 *
 * Provides helpers to convert between VideoFrame, ImageBitmap, and ImageData.
 * Supports both GPU-accelerated (VideoFrame, ImageBitmap) and CPU (ImageData) formats.
 *
 * Performance hierarchy (fastest to slowest):
 * 1. VideoFrame (GPU-resident, no copy)
 * 2. ImageBitmap (GPU-resident, minimal copy)
 * 3. ImageData (CPU-resident, full GPU→CPU transfer)
 *
 * @example
 * // Convert single frame
 * const imageData = await frameToImageData(videoFrame, canvas, context);
 *
 * // Convert array of frames
 * const imageDataArray = await convertFramesToImageData(videoFrames, width, height);
 */

import type { EncoderFrame } from './encoder-interface';

/**
 * Convert a single frame to ImageData
 *
 * Handles VideoFrame, ImageBitmap, and ImageData inputs. Uses canvas
 * for GPU-accelerated conversion when possible.
 *
 * @param frame - Frame to convert (VideoFrame, ImageBitmap, or ImageData)
 * @param canvas - Canvas element for GPU operations
 * @param context - 2D rendering context
 * @returns ImageData representation of the frame
 *
 * @example
 * const canvas = document.createElement('canvas');
 * const context = canvas.getContext('2d')!;
 * const imageData = await frameToImageData(videoFrame, canvas, context);
 */
export async function frameToImageData(
  frame: EncoderFrame,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D
): Promise<ImageData> {
  // Fast path: already ImageData
  if (frame instanceof ImageData) {
    return frame;
  }

  // Get frame dimensions
  const width = 'displayWidth' in frame ? frame.displayWidth : frame.width;
  const height = 'displayHeight' in frame ? frame.displayHeight : frame.height;

  // Ensure canvas is correct size
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // VideoFrame path: try VideoFrame.copyTo() first (fastest)
  if ('format' in frame && 'copyTo' in frame) {
    try {
      // VideoFrame.copyTo() - direct GPU→CPU transfer
      const buffer = new Uint8ClampedArray(width * height * 4);
      await (frame as VideoFrame).copyTo(buffer, {
        rect: { x: 0, y: 0, width, height },
      });
      return new ImageData(buffer, width, height);
    } catch (_error) {
      // copyTo() not supported or failed - fall through to canvas path
      // (This is expected on some browsers/formats)
    }
  }

  // Canvas path: draw to canvas then read pixels (slower but universal)
  // Works for both VideoFrame and ImageBitmap
  context.drawImage(frame as CanvasImageSource, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

/**
 * Convert array of frames to ImageData array
 *
 * Batch converts multiple frames with a single canvas allocation.
 * Reuses canvas and context across all frames for efficiency.
 *
 * Note: This does NOT close VideoFrames - caller must close them after encoding.
 *
 * @param frames - Array of frames to convert
 * @param width - Frame width
 * @param height - Frame height
 * @param onProgress - Optional progress callback (current, total)
 * @param shouldCancel - Optional cancellation check
 * @returns Promise resolving to ImageData array
 * @throws {Error} If conversion is cancelled
 *
 * @example
 * const imageDataArray = await convertFramesToImageData(
 *   videoFrames,
 *   640,
 *   480,
 *   (current, total) => logger.debug('encoders', 'Frame conversion progress', { current, total }),
 *   () => cancelRequested
 * );
 */
export async function convertFramesToImageData(
  frames: EncoderFrame[],
  width: number,
  height: number,
  onProgress?: (current: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<ImageData[]> {
  // Fast path: all frames already ImageData
  const allImageData = frames.every((f) => f instanceof ImageData);
  if (allImageData) {
    return frames as ImageData[];
  }

  // Create shared canvas for conversions
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: false,
  });

  if (!context) {
    throw new Error('Failed to create 2D canvas context for frame conversion');
  }

  // Convert each frame
  const imageDataArray: ImageData[] = [];

  for (let i = 0; i < frames.length; i++) {
    // Check cancellation
    if (shouldCancel?.()) {
      throw new Error('Frame conversion cancelled');
    }

    const frame = frames[i];
    if (!frame) {
      throw new Error(`Frame at index ${i} is undefined`);
    }
    const imageData = await frameToImageData(frame, canvas, context);
    imageDataArray.push(imageData);

    // Report progress
    onProgress?.(i + 1, frames.length);
  }

  return imageDataArray;
}

/**
 * Check if a frame needs conversion to ImageData
 *
 * Returns true if the frame is VideoFrame or ImageBitmap (requires conversion).
 * Returns false if the frame is already ImageData (no conversion needed).
 *
 * @param frame - Frame to check
 * @returns True if conversion is needed
 *
 * @example
 * if (needsConversion(frame)) {
 *   imageData = await frameToImageData(frame, canvas, context);
 * } else {
 *   imageData = frame;
 * }
 */
export function needsConversion(frame: EncoderFrame): boolean {
  return !(frame instanceof ImageData);
}

/**
 * Get frame dimensions
 *
 * Extracts width and height from any frame type. Handles different
 * property names across VideoFrame, ImageBitmap, and ImageData.
 *
 * @param frame - Frame to measure
 * @returns Object with width and height
 *
 * @example
 * const { width, height } = getFrameDimensions(videoFrame);
 * canvas.width = width;
 * canvas.height = height;
 */
export function getFrameDimensions(frame: EncoderFrame): {
  width: number;
  height: number;
} {
  if (frame instanceof ImageData) {
    return { width: frame.width, height: frame.height };
  }

  if ('displayWidth' in frame && 'displayHeight' in frame) {
    // VideoFrame
    return {
      width: frame.displayWidth,
      height: frame.displayHeight,
    };
  }

  // ImageBitmap
  return { width: frame.width, height: frame.height };
}

/**
 * Close VideoFrames in array
 *
 * Safely closes VideoFrame objects to free GPU resources. Skips
 * ImageBitmap and ImageData (no cleanup needed).
 *
 * Call this after encoding is complete to prevent memory leaks.
 *
 * @param frames - Array of frames (may contain mixed types)
 *
 * @example
 * try {
 *   const blob = await encoder.encode({ frames: videoFrames, ... });
 *   return blob;
 * } finally {
 *   closeVideoFrames(videoFrames);
 * }
 */
export function closeVideoFrames(frames: EncoderFrame[]): void {
  for (const frame of frames) {
    if ('format' in frame && 'close' in frame) {
      try {
        (frame as VideoFrame).close();
      } catch (_error) {
        // Frame might already be closed - ignore
      }
    }
  }
}
