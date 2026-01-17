/**
 * WebP frame encoding helper.
 *
 * Converts ImageData → WebP bytes using OffscreenCanvas when available.
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
        ? await (canvas as OffscreenCanvas).convertToBlob({
            type: 'image/webp',
            quality,
          })
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
