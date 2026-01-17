import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

/**
 * Validate WebP blob output.
 *
 * Checks WebP file signature, minimum size, and (best-effort) decodability.
 */
export async function validateWebPBlob(blob: Blob): Promise<{ valid: boolean; reason?: string }> {
  if (blob.size < FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_WEBP_SIZE_BYTES) {
    return {
      valid: false,
      reason: `WebP output too small (${blob.size} bytes)`,
    };
  }

  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const riffSignature = String.fromCharCode(...header.slice(0, 4));
  const webpSignature = String.fromCharCode(...header.slice(8, 12));
  if (riffSignature !== 'RIFF' || webpSignature !== 'WEBP') {
    return {
      valid: false,
      reason: 'Invalid WebP file signature',
    };
  }

  // Animated WebP decode support differs across browsers/APIs.
  // `createImageBitmap()` may fail even for valid animated WebP files.
  // Detect animation chunks and treat decode failures as non-fatal in that case.
  const scanLimitBytes = Math.min(blob.size, 256 * 1024);
  const scanBytes = new Uint8Array(await blob.slice(0, scanLimitBytes).arrayBuffer());

  const containsFourCc = (bytes: Uint8Array, fourcc: string): boolean => {
    if (fourcc.length !== 4 || bytes.length < 4) {
      return false;
    }

    const a = fourcc.charCodeAt(0);
    const b = fourcc.charCodeAt(1);
    const c = fourcc.charCodeAt(2);
    const d = fourcc.charCodeAt(3);

    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) {
        return true;
      }
    }
    return false;
  };

  const isAnimatedWebP = containsFourCc(scanBytes, 'ANIM') || containsFourCc(scanBytes, 'ANMF');

  // Quick structural sanity check: animated WebP requires VP8X with the animation flag set.
  // If we accidentally produce ANIM/ANMF without VP8X.animation, many decoders will reject
  // the file (and users will see an "empty"/unopenable output).
  const tryReadVp8xFlags = (bytes: Uint8Array): number | null => {
    if (bytes.length < 12) {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const readFourCcAt = (offset: number): string =>
      String.fromCharCode(
        bytes[offset] ?? 0,
        bytes[offset + 1] ?? 0,
        bytes[offset + 2] ?? 0,
        bytes[offset + 3] ?? 0
      );

    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const fourcc = readFourCcAt(offset);
      const chunkSize = view.getUint32(offset + 4, true);
      const payloadStart = offset + 8;
      const payloadEnd = payloadStart + chunkSize;

      if (payloadEnd > bytes.length) {
        return null;
      }

      if (fourcc === 'VP8X') {
        if (chunkSize < 1) {
          return null;
        }
        return bytes[payloadStart] ?? null;
      }

      offset = payloadEnd + (chunkSize % 2);
    }

    return null;
  };

  if (isAnimatedWebP) {
    const vp8xFlags = tryReadVp8xFlags(scanBytes);
    if (vp8xFlags === null) {
      return {
        valid: false,
        reason: 'Animated WebP missing VP8X header chunk',
      };
    }

    const VP8X_ANIMATION_FLAG = 0x02;
    if ((vp8xFlags & VP8X_ANIMATION_FLAG) === 0) {
      return {
        valid: false,
        reason: 'Animated WebP missing VP8X animation flag',
      };
    }
  }

  const tryDecodeWithImageElement = async (): Promise<void> => {
    if (typeof document === 'undefined') {
      throw new Error('Document unavailable for WebP decode check');
    }

    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;

      if (typeof img.decode === 'function') {
        await img.decode();
        return;
      }

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Image element failed to decode WebP'));
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      bitmap.close();
    } catch (error) {
      if (isAnimatedWebP) {
        // Best-effort fallback decode check.
        try {
          await tryDecodeWithImageElement();
          return { valid: true };
        } catch (imgError) {
          logger.warn(
            'conversion',
            'Animated WebP decode check failed; accepting based on container validation',
            {
              size: blob.size,
              createImageBitmapError: getErrorMessage(error),
              imageDecodeError: getErrorMessage(imgError),
            }
          );
          return { valid: true };
        }
      }

      return {
        valid: false,
        reason: `WebP decode failed: ${getErrorMessage(error)}`,
      };
    }
  }

  return { valid: true };
}
