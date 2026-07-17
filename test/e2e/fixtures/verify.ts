import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';

const execFileAsync = promisify(execFile);

/**
 * Probe a media file using ffprobe and return metadata.
 */
export async function probeFile(filePath: string): Promise<{
  format: string;
  width: number;
  height: number;
  duration: number;
  frameCount: number;
  codec: string;
}> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-count_frames',
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new Error(`No stream found in ${filePath}`);

  const format = data.format?.format_name?.split(',')[0] || 'unknown';
  const duration = parseFloat(data.format?.duration || '0');
  const frameCount = parseInt(stream.nb_frames || '0', 10) ||
    Math.round(duration * (parseFloat(stream.r_frame_rate?.split('/')[0] || '0') / parseFloat(stream.r_frame_rate?.split('/')[1] || '1')));

  return {
    format,
    width: parseInt(stream.width, 10),
    height: parseInt(stream.height, 10),
    duration,
    frameCount,
    codec: stream.codec_name,
  };
}

/**
 * Extract a specific frame from a GIF/WebP and return raw RGBA pixel data.
 */
export async function extractFrame(filePath: string, frameIndex = 0): Promise<Buffer> {
  const outputPath = `/tmp/frame_${frameIndex}.rgba`;
  await execFileAsync('ffmpeg', [
    '-i', filePath,
    '-vf', `select=eq(n\\,${frameIndex})`,
    '-vframes', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    outputPath,
    '-y',
  ]);

  const fs = await import('node:fs');
  return fs.readFileSync(outputPath);
}

/**
 * Get the center pixel color of a GIF frame.
 */
export async function getFrameCenterColor(filePath: string, frameIndex = 0): Promise<{ r: number; g: number; b: number }> {
  const probe = await probeFile(filePath);
  const { width, height } = probe;

  const { stdout } = await execFileAsync('ffmpeg', [
    '-i', filePath,
    '-vf', `select=eq(n\\,${frameIndex}),crop=1:1:${Math.floor(width / 2)}:${Math.floor(height / 2)}`,
    '-vframes', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
    '-y',
  ]);

  if (!stdout || Buffer.byteLength(stdout, 'binary') < 3) {
    throw new Error(`Failed to extract frame ${frameIndex} from ${filePath}`);
  }

  const buf = Buffer.from(stdout, 'binary');
  return { r: buf[0] as number, g: buf[1] as number, b: buf[2] as number };
}

// ─── Magic byte validation (no external tools required) ──

/**
 * Validate GIF file by checking magic bytes.
 * GIF files start with "GIF89a" or "GIF87a" and end with 0x3B.
 */
export function validateGifMagic(bytes: Uint8Array): { valid: boolean; width?: number; height?: number } {
  if (bytes.length < 10) return { valid: false };

  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (header !== 'GIF89a' && header !== 'GIF87a') return { valid: false };

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
  if (bytes.length < 12) return { valid: false };

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
  buffer: Buffer,
  expectedFormat: 'gif' | 'webp'
): { valid: boolean; width?: number; height?: number; message: string } {
  const bytes = new Uint8Array(buffer);

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

// ─── ffprobe-based validation (requires ffprobe) ──

export async function isValidGif(filePath: string): Promise<boolean> {
  try {
    const probe = await probeFile(filePath);
    return probe.format === 'gif';
  } catch {
    return false;
  }
}

export async function isValidWebP(filePath: string): Promise<boolean> {
  try {
    const probe = await probeFile(filePath);
    return probe.format === 'webp' || probe.codec === 'webp';
  } catch {
    return false;
  }
}

export async function getGifFrameCount(filePath: string): Promise<number> {
  const probe = await probeFile(filePath);
  return probe.frameCount;
}
