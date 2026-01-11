/**
 * Canvas Processor
 *
 * Provides canvas-based frame processing for GPU path.
 * Handles canvas creation, frame rendering, and encoding to various formats.
 *
 * Features:
 * - OffscreenCanvas support for better performance
 * - ImageData to WebP frame encoding
 * - Reusable encoder functions for batch processing
 */

export interface CaptureContext {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  targetWidth: number;
  targetHeight: number;
}

/**
 * Create a canvas context for frame capture
 *
 * Prefers OffscreenCanvas when available for better performance.
 *
 * @param width - Canvas width in pixels
 * @param height - Canvas height in pixels
 * @param willReadFrequently - Hint for frequent pixel reads (e.g., RGBA format)
 * @returns Canvas context object
 */
export function createCanvas(
  width: number,
  height: number,
  willReadFrequently = false
): CaptureContext {
  // Prefer OffscreenCanvas when available.
  // In Chrome/Edge, OffscreenCanvas.convertToBlob() is typically faster and can reduce
  // main-thread blocking during PNG/JPEG encoding.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently });
    if (!context) {
      throw new Error('Canvas 2D context not available');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    return { canvas, context, targetWidth: width, targetHeight: height };
  }

  const hasDocument = typeof document !== 'undefined';
  if (!hasDocument) {
    throw new Error('Canvas rendering is not available in this environment.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently });
  if (!context) {
    throw new Error('Canvas 2D context not available');
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return { canvas, context, targetWidth: width, targetHeight: height };
}

/**
 * Convert a canvas to a Blob
 *
 * @param canvas - Canvas to convert
 * @param mimeType - Output MIME type (e.g., 'image/png', 'image/jpeg', 'image/webp')
 * @param quality - Quality ratio (0.0 to 1.0) - only for lossy formats
 * @returns Promise resolving to encoded blob
 */
export async function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: mimeType, quality });
  }

  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => {
    htmlCanvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error('Failed to capture frame'));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Create WebP frame encoder function
 *
 * Returns a reusable encoder function that converts ImageData to WebP format.
 * Uses OffscreenCanvas when available for better performance.
 *
 * @param qualityRatio - Quality ratio (0.0 to 1.0)
 * @returns Async function that encodes ImageData to WebP Uint8Array
 */
export function createWebPFrameEncoder(
  qualityRatio: number
): (frame: ImageData) => Promise<Uint8Array> {
  let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  return async (frame: ImageData): Promise<Uint8Array> => {
    if (!canvas) {
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(frame.width, frame.height);
        context = canvas.getContext('2d');
      } else {
        const createdCanvas = document.createElement('canvas');
        createdCanvas.width = frame.width;
        createdCanvas.height = frame.height;
        canvas = createdCanvas;
        context = createdCanvas.getContext('2d');
      }
    }

    if (!canvas || !context) {
      throw new Error('Canvas context unavailable for WebP frame encoding.');
    }

    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }

    context.putImageData(frame, 0, 0);

    const quality = Math.min(1, Math.max(0, qualityRatio));
    const blob =
      'convertToBlob' in canvas
        ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/webp', quality })
        : await new Promise<Blob>((resolve, reject) => {
            (canvas as HTMLCanvasElement).toBlob(
              (result) => {
                if (result && result.size > 0) {
                  resolve(result);
                  return;
                }
                reject(new Error('Failed to encode WebP frame via toBlob.'));
              },
              'image/webp',
              quality
            );
          });

    if (!blob || blob.size === 0) {
      throw new Error('WebP frame encoding produced an empty blob.');
    }

    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };
}

/**
 * Draw video frame or VideoFrame to canvas
 *
 * @param context - Canvas rendering context
 * @param source - Source video element or VideoFrame
 * @param width - Target width
 * @param height - Target height
 */
export function drawVideoFrame(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: HTMLVideoElement | VideoFrame,
  width: number,
  height: number
): void {
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
}

/**
 * Encode canvas to format
 *
 * @param canvas - Canvas to encode
 * @param format - Output format ('png', 'jpeg', 'webp')
 * @param quality - Quality ratio (0.0 to 1.0) - only for lossy formats
 * @returns Promise resolving to encoded Uint8Array
 */
export async function encodeCanvasToFormat(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  format: 'png' | 'jpeg' | 'webp',
  quality?: number
): Promise<Uint8Array> {
  const mimeType = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const blob = await canvasToBlob(canvas, mimeType, quality);
  if (blob.size === 0) {
    throw new Error(`Canvas encoding to ${format} produced empty blob`);
  }
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
