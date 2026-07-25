/**
 * Pure byte-level magic validation — no external tools required.
 *
 * These functions read only from the provided Uint8Array/Buffer and do not
 * invoke child processes, fs, or other Node.js built-ins. They can safely be
 * imported in jsdom Vitest environments (used by `test/unit/e2e-fixtures.test.ts`).
 */

/**
 * Validate GIF file by checking magic bytes.
 * GIF files start with "GIF89a" or "GIF87a" and end with 0x3B.
 */
export function validateGifMagic(bytes: Uint8Array): { valid: boolean; width?: number; height?: number } {
  if (bytes.length < 10) return { valid: false };

  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (header !== 'GIF89a' && header !== 'GIF87a') return { valid: false };
  if (bytes[bytes.length - 1] !== 0x3b) return { valid: false };

  // Logical Screen Descriptor: bytes 6-9 contain width (little-endian) and height (little-endian)
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);

  return { valid: true, width, height };
}

/**
 * Validate WebP file by checking magic bytes.
 * WebP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
 */
export function validateWebpMagic(bytes: Uint8Array): { valid: boolean; width?: number; height?: number } {
  if (bytes.length < 20) return { valid: false };

  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff !== 'RIFF' || webp !== 'WEBP') return { valid: false };

  // For VP8 (lossy): bytes 12-15 = "VP8 ", then dimensions at offset 26-29
  // For VP8L (lossless): bytes 12-15 = "VP8L", then dimensions at offset 21-24
  const codec = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (codec === 'VP8 ' && bytes.length >= 30) {
    // VP8: width at offset 26-27, height at offset 28-29 (little-endian, 14-bit each)
    const w = (bytes[26]! | (bytes[27]! << 8)) & 0x3FFF;
    const h = (bytes[28]! | (bytes[29]! << 8)) & 0x3FFF;
    return { valid: true, width: w, height: h };
  }
  if (codec === 'VP8L' && bytes.length >= 25) {
    // VP8L: dimensions encoded differently, skip for now
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Validate a downloaded file's magic bytes against expected format.
 * Works without ffprobe — pure byte inspection.
 */
export function validateFileMagic(
  buffer: Uint8Array | ArrayBuffer,
  expectedFormat: 'gif' | 'webp'
): { valid: boolean; width?: number; height?: number; message: string } {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (expectedFormat === 'gif') {
    const result = validateGifMagic(bytes);
    if (!result.valid) {
      const headerHex = Array.from(bytes.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return { valid: false, message: `Invalid GIF magic: ${headerHex}` };
    }
    return { valid: true, width: result.width, height: result.height, message: 'Valid GIF' };
  }

  if (expectedFormat === 'webp') {
    const result = validateWebpMagic(bytes);
    if (!result.valid) {
      const headerHex = Array.from(bytes.slice(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return { valid: false, message: `Invalid WebP magic: ${headerHex}` };
    }
    return { valid: true, width: result.width, height: result.height, message: 'Valid WebP' };
  }

  return { valid: false, message: `Unknown format: ${expectedFormat}` };
}