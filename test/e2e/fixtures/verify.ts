import type { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { validateGifMagic, validateWebpMagic } from './validate-magic';

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
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'v:0',
    '-count_frames',
    filePath,
  ]);

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream) throw new Error(`No stream found in ${filePath}`);

  const format = data.format?.format_name?.split(',')[0] || 'unknown';
  const duration = parseFloat(data.format?.duration || '0');
  const frameCount =
    parseInt(stream.nb_read_frames || '0', 10) ||
    parseInt(stream.nb_frames || '0', 10) ||
    Math.round(
      duration *
        (parseFloat(stream.r_frame_rate?.split('/')[0] || '0') /
          parseFloat(stream.r_frame_rate?.split('/')[1] || '1'))
    );

  return {
    format,
    width: parseInt(stream.width, 10),
    height: parseInt(stream.height, 10),
    duration,
    frameCount,
    codec: stream.codec_name,
  };
}

/** Decode every video frame and fail on any FFmpeg warning promoted by -xerror. */
export async function decodeFileFully(filePath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-xerror',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-f',
    'null',
    '-',
  ]);
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
      const headerHex = Array.from(bytes.slice(0, 12))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      return { valid: false, message: `Invalid GIF magic: ${headerHex}` };
    }
    return { ...result, message: 'Valid GIF' };
  }

  if (expectedFormat === 'webp') {
    const result = validateWebpMagic(bytes);
    if (!result.valid) {
      const headerHex = Array.from(bytes.slice(0, 12))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      return { valid: false, message: `Invalid WebP magic: ${headerHex}` };
    }
    return { ...result, message: 'Valid WebP' };
  }

  return { valid: false, message: `Unknown format: ${expectedFormat}` };
}
