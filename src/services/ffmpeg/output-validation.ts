import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';

type OutputValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Validate an output file payload for basic correctness.
 * Checks minimum size and magic bytes.
 */
export const validateOutputBytes = (
  data: Uint8Array,
  expectedFormat: 'gif' | 'webp'
): OutputValidationResult => {
  const minSize =
    expectedFormat === 'gif'
      ? FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_GIF_SIZE_BYTES
      : FFMPEG_INTERNALS.OUTPUT_VALIDATION.MIN_WEBP_SIZE_BYTES;

  if (data.length < minSize) {
    return {
      valid: false,
      reason: `Output file too small (${data.length} bytes, expected ≥${minSize})`,
    };
  }

  if (expectedFormat === 'gif') {
    // GIF signature: "GIF89a" or "GIF87a"
    const gifSignature = String.fromCharCode(...data.slice(0, 6));
    if (!gifSignature.startsWith('GIF8')) {
      return {
        valid: false,
        reason: `Invalid GIF file signature (${gifSignature})`,
      };
    }
  }

  if (expectedFormat === 'webp') {
    // WebP signature: "RIFF....WEBP"
    const riffSignature = String.fromCharCode(...data.slice(0, 4));
    const webpSignature = String.fromCharCode(...data.slice(8, 12));
    if (riffSignature !== 'RIFF' || webpSignature !== 'WEBP') {
      return {
        valid: false,
        reason: `Invalid WebP file signature (${riffSignature}/${webpSignature})`,
      };
    }
  }

  return { valid: true };
};
