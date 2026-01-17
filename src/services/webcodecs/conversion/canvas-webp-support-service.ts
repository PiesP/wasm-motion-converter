import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import { withTimeout } from '@utils/with-timeout';

const DEFAULT_TIMEOUT_MS = 2_000;
const CANVAS_SIZE = 2;
const WEBP_QUALITY = 0.8;

const hasDocument = (): boolean => typeof document !== 'undefined';

const createProbeCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  return canvas;
};

const drawProbePixel = (ctx: CanvasRenderingContext2D): void => {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
};

const toWebpBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        resolve(blob ?? null);
      },
      'image/webp',
      WEBP_QUALITY
    );
  });

const runCanvasProbe = async (): Promise<boolean> => {
  try {
    const canvas = createProbeCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return false;
    }

    drawProbePixel(ctx);
    const blob = await toWebpBlob(canvas);
    return Boolean(blob && blob.size > 0);
  } catch {
    return false;
  }
};

/**
 * Probe whether this browser can encode WebP images via Canvas.
 *
 * This is a lightweight preflight check used to avoid repeated per-frame
 * failures in the WebP muxer path on browsers without WebP encoding support.
 */
export async function probeCanvasWebPEncodeSupport(
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  if (!hasDocument()) {
    return false;
  }

  try {
    return await withTimeout(runCanvasProbe(), timeoutMs, 'Canvas WebP encode probe timed out');
  } catch (error) {
    logger.debug('conversion', 'Canvas WebP encode probe failed (non-critical)', {
      error: getErrorMessage(error),
    });
    return false;
  }
}
