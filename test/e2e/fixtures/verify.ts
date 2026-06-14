import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
 * For animated WebP, use getWebPFrameColor instead.
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

/**
 * Check if a file is a valid GIF.
 */
export async function isValidGif(filePath: string): Promise<boolean> {
  try {
    const probe = await probeFile(filePath);
    return probe.format === 'gif';
  } catch {
    return false;
  }
}

/**
 * Check if a file is a valid WebP.
 */
export async function isValidWebP(filePath: string): Promise<boolean> {
  try {
    const probe = await probeFile(filePath);
    return probe.format === 'webp' || probe.codec === 'webp';
  } catch {
    return false;
  }
}

/**
 * Get GIF frame count.
 */
export async function getGifFrameCount(filePath: string): Promise<number> {
  const probe = await probeFile(filePath);
  return probe.frameCount;
}
