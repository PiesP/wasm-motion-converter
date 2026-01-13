import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { withTimeout } from '@utils/with-timeout';

/**
 * Probe whether this browser can encode WebP images via Canvas.
 *
 * This is a lightweight preflight check used to avoid repeated per-frame
 * failures in the WebP muxer path on browsers without WebP encoding support.
 */
export async function probeCanvasWebPEncodeSupport(timeoutMs: number = 2_000): Promise<boolean> {
  // Browser-only.
  if (typeof document === 'undefined') {
    return false;
  }

  try {
    return await withTimeout(
      new Promise<boolean>((resolve) => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 2;
          canvas.height = 2;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(false);
            return;
          }

          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, 2, 2);

          canvas.toBlob(
            (blob) => {
              resolve(Boolean(blob && blob.size > 0));
            },
            'image/webp',
            0.8
          );
        } catch {
          resolve(false);
        }
      }),
      timeoutMs,
      'Canvas WebP encode probe timed out'
    );
  } catch (error) {
    logger.debug('conversion', 'Canvas WebP encode probe failed (non-critical)', {
      error: getErrorMessage(error),
    });
    return false;
  }
}
