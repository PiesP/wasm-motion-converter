/**
 * Canvas helpers for WebCodecs frame capture.
 */
type CaptureContext = {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  targetWidth: number;
  targetHeight: number;
};

/**
 * Create a canvas context for frame capture.
 */
export const createCanvas = (
  width: number,
  height: number,
  willReadFrequently: boolean = false
): CaptureContext => {
  // Prefer OffscreenCanvas when available.
  // In Chrome/Edge, OffscreenCanvas.convertToBlob() is typically faster and can reduce
  // main-thread blocking during PNG/JPEG encoding.
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently,
    });
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
};

/**
 * Convert a canvas to a Blob.
 */
export const canvasToBlob = async (
  canvas: OffscreenCanvas | HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> => {
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
};
