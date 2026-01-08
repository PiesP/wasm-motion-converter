import { logger } from './logger';

/**
 * Custom Animated WebP Muxer
 *
 * Constructs animated WebP files from individually encoded WebP frames.
 * This bypasses FFmpeg.wasm's image2 demuxer PTS initialization bug.
 *
 * WebP Container Structure:
 * - RIFF header
 * - VP8X chunk (extended format)
 * - ANIM chunk (animation parameters)
 * - ANMF chunks (frames with duration)
 *
 * @see https://developers.google.com/speed/webp/docs/riff_container
 */

/**
 * Options for creating an animated WebP file
 */
export interface AnimatedWebPOptions {
  /** Canvas width in pixels (1 to 16777215) */
  width: number;
  /** Canvas height in pixels (1 to 16777215) */
  height: number;
  /** Number of loops (0 = infinite) */
  loopCount: number;
  /** Background color (RGBA) */
  backgroundColor: { r: number; g: number; b: number; a: number };
  /** Whether frames have alpha channel */
  hasAlpha?: boolean;
}

/**
 * Represents a single WebP frame in an animation
 */
export interface WebPFrame {
  /** Encoded WebP frame data (may be full RIFF container or just payload) */
  data: ArrayBuffer;
  /** Frame display duration in milliseconds (1 to 16777215) */
  duration: number;
}

const MAX_24BIT = 0xffffff; // 24-bit unsigned integer max
const MIN_DURATION_MS = 1;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = MAX_24BIT + 1; // Stored as (value - 1) in bitstream

/**
 * Clamp a value to 24-bit range (0-16777215)
 *
 * @param value - Value to clamp
 * @param fallback - Value to use if input is invalid
 * @returns Clamped value between 0 and MAX_24BIT
 */
const clamp24Bit = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) {
    return fallback;
  }
  return Math.min(MAX_24BIT, Math.round(value));
};

/**
 * Normalize frame duration to valid WebP range
 *
 * @param duration - Duration in milliseconds
 * @returns Valid duration (minimum 1ms, maximum 24-bit)
 */
const normalizeDuration = (duration: number): number =>
  clamp24Bit(Math.max(MIN_DURATION_MS, duration), MIN_DURATION_MS);

/**
 * Validate and normalize dimension to WebP spec
 *
 * @param value - Dimension value (width or height)
 * @param label - Label for error messages ('width' or 'height')
 * @returns Normalized dimension
 * @throws Error if value is invalid or exceeds 24-bit range
 */
const normalizeDimension = (value: number, label: 'width' | 'height'): number => {
  if (!Number.isFinite(value) || value < MIN_DIMENSION) {
    throw new Error(`Invalid ${label} for animated WebP: ${value}`);
  }
  if (value > MAX_DIMENSION) {
    throw new Error(
      `Animated WebP ${label} exceeds 24-bit limit (${value} > ${MAX_DIMENSION}). Please scale down before encoding.`
    );
  }
  return Math.round(value);
};

/**
 * Clamp color channel value to 0-255 range
 *
 * @param value - Color channel value
 * @returns Clamped value between 0 and 255
 */
const clampColorChannel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

/**
 * Concatenate multiple Uint8Array chunks into a single buffer
 *
 * @param chunks - Array of Uint8Array chunks
 * @param totalLength - Expected total length (for validation)
 * @returns Concatenated buffer
 */
const concatChunks = (chunks: Uint8Array[], totalLength: number): Uint8Array => {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/**
 * Strip RIFF container from WebP frame data
 *
 * WebP frames produced by canvas/OffscreenCanvas include a full RIFF container.
 * ANMF payloads must contain only the inner WebP chunks (VP8/VP8L/VP8X), not the outer RIFF header.
 *
 * @param data - WebP frame data (may be full RIFF or just payload)
 * @returns Inner WebP payload without RIFF header
 */
const stripWebPContainer = (data: ArrayBuffer): Uint8Array => {
  const bytes = new Uint8Array(data);
  if (bytes.length < 12) {
    return bytes;
  }

  const isRIFF = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // 'RIFF'
  const isWEBP = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50; // 'WEBP'

  if (!isRIFF || !isWEBP) {
    return bytes;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true); // Little-endian size (excludes first 8 bytes)
  const payloadStart = 12; // Skip RIFF header + 'WEBP'
  // RIFF size = file size - 8 (RIFF fourCC + size field), so payload ends at 8 + riffSize
  const payloadEnd = Math.min(bytes.length, 8 + riffSize);

  if (payloadEnd <= payloadStart) {
    return bytes;
  }

  return bytes.slice(payloadStart, payloadEnd);
};

/**
 * Write a 32-bit little-endian unsigned integer
 *
 * @param value - Value to encode (0 to 4294967295)
 * @returns 4-byte buffer in little-endian format
 */
function writeUint32LE(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  buffer[0] = value & 0xff;
  buffer[1] = (value >> 8) & 0xff;
  buffer[2] = (value >> 16) & 0xff;
  buffer[3] = (value >> 24) & 0xff;
  return buffer;
}

/**
 * Write a 24-bit little-endian unsigned integer
 *
 * @param value - Value to encode (0 to 16777215)
 * @returns 3-byte buffer in little-endian format
 */
function writeUint24LE(value: number): Uint8Array {
  const buffer = new Uint8Array(3);
  buffer[0] = value & 0xff;
  buffer[1] = (value >> 8) & 0xff;
  buffer[2] = (value >> 16) & 0xff;
  return buffer;
}

/**
 * Write a FourCC (Four Character Code) identifier
 *
 * @param fourcc - 4-character ASCII string (e.g., 'RIFF', 'WEBP')
 * @returns 4-byte buffer containing ASCII characters
 * @throws Error if fourcc is not exactly 4 characters
 */
function writeFourCC(fourcc: string): Uint8Array {
  if (fourcc.length !== 4) {
    throw new Error(`FourCC must be exactly 4 characters, got: "${fourcc}"`);
  }
  const buffer = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    buffer[i] = fourcc.charCodeAt(i);
  }
  return buffer;
}

/**
 * Create VP8X (Extended Format) chunk
 *
 * Flags: 0x10 (ANIMATION_FLAG) | 0x08 (ALPHA_FLAG if needed)
 *
 * @param width - Canvas width in pixels
 * @param height - Canvas height in pixels
 * @param hasAlpha - Whether frames contain alpha channel
 * @returns Complete VP8X chunk (FourCC + size + payload)
 */
function createVP8XChunk(width: number, height: number, hasAlpha: boolean): Uint8Array {
  const chunkSize = 10;
  const flags = 0x10 | (hasAlpha ? 0x08 : 0x00); // ANIMATION | ALPHA

  const chunks: Uint8Array[] = [
    writeFourCC('VP8X'),
    writeUint32LE(chunkSize),
    new Uint8Array([flags, 0, 0, 0]), // Flags (4 bytes)
    writeUint24LE(width - 1), // Canvas width - 1 (24 bits)
    writeUint24LE(height - 1), // Canvas height - 1 (24 bits)
  ];

  const totalLength = 4 + 4 + chunkSize; // FourCC + chunk size + payload
  return concatChunks(chunks, totalLength);
}

/**
 * Create ANIM (Animation) chunk
 *
 * Specifies animation parameters: background color and loop count
 *
 * @param backgroundColor - Background color in RGBA format
 * @param loopCount - Number of loops (0 = infinite, max 65535)
 * @returns Complete ANIM chunk (FourCC + size + payload)
 */
function createANIMChunk(
  backgroundColor: { r: number; g: number; b: number; a: number },
  loopCount: number
): Uint8Array {
  const chunkSize = 6;

  const chunks: Uint8Array[] = [
    writeFourCC('ANIM'),
    writeUint32LE(chunkSize),
    new Uint8Array([backgroundColor.r, backgroundColor.g, backgroundColor.b, backgroundColor.a]),
    new Uint8Array([loopCount & 0xff, (loopCount >> 8) & 0xff]), // Loop count (16 bits)
  ];

  const totalLength = 4 + 4 + chunkSize;
  return concatChunks(chunks, totalLength);
}

/**
 * Create ANMF (Animation Frame) chunk
 *
 * Encodes a single frame with display duration and positioning
 *
 * @param frameData - Encoded WebP frame data
 * @param duration - Frame display duration in milliseconds
 * @param width - Canvas width in pixels
 * @param height - Canvas height in pixels
 * @returns Complete ANMF chunk (FourCC + size + header + payload + padding if needed)
 */
function createANMFChunk(
  frameData: ArrayBuffer,
  duration: number,
  width: number,
  height: number
): Uint8Array {
  const frameBytes = stripWebPContainer(frameData);
  const frameSize = frameBytes.length;
  const chunkHeaderSize = 16; // ANMF header without frame data
  const chunkSize = chunkHeaderSize + frameSize;
  const normalizedDuration = normalizeDuration(duration);

  const chunks: Uint8Array[] = [
    writeFourCC('ANMF'),
    writeUint32LE(chunkSize),
    writeUint24LE(0), // Frame X (24 bits) - always 0 for full-frame
    writeUint24LE(0), // Frame Y (24 bits) - always 0 for full-frame
    writeUint24LE(width - 1), // Frame width - 1 (24 bits)
    writeUint24LE(height - 1), // Frame height - 1 (24 bits)
    writeUint24LE(normalizedDuration), // Duration in milliseconds (24 bits)
    new Uint8Array([0]), // Flags: 0 = no blending, no disposal
    frameBytes, // Encoded frame data
  ];

  // Add padding byte if frame data size is odd
  const needsPadding = frameSize % 2 === 1;
  if (needsPadding) {
    chunks.push(new Uint8Array([0]));
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return concatChunks(chunks, totalLength);
}

/**
 * Mux individually encoded WebP frames into an animated WebP file
 *
 * Combines pre-encoded WebP frames into a single animated WebP container.
 * This approach allows fine-grained control over frame encoding and avoids
 * FFmpeg.wasm's PTS initialization bugs in image2 demuxer.
 *
 * @param frames - Array of encoded WebP frames with durations
 * @param options - Canvas dimensions, background color, loop count, alpha channel
 * @returns Complete animated WebP file as ArrayBuffer
 * @throws Error if frames is empty, dimensions invalid, or encoding fails
 *
 * @example
 * const frames: WebPFrame[] = [
 *   { data: frame1Blob, duration: 100 },
 *   { data: frame2Blob, duration: 100 }
 * ];
 * const options: AnimatedWebPOptions = {
 *   width: 800,
 *   height: 600,
 *   loopCount: 0,
 *   backgroundColor: { r: 255, g: 255, b: 255, a: 255 },
 *   hasAlpha: true
 * };
 * const animatedWebP = await muxAnimatedWebP(frames, options);
 */
export async function muxAnimatedWebP(
  frames: WebPFrame[],
  options: AnimatedWebPOptions
): Promise<ArrayBuffer> {
  if (frames.length === 0) {
    const error = 'No frames provided for animated WebP';
    logger.error('general', error);
    throw new Error(error);
  }

  try {
    const width = normalizeDimension(options.width, 'width');
    const height = normalizeDimension(options.height, 'height');
    const loopCount = Math.max(0, Math.min(0xffff, Math.round(options.loopCount)));
    const backgroundColor = {
      r: clampColorChannel(options.backgroundColor?.r ?? 0),
      g: clampColorChannel(options.backgroundColor?.g ?? 0),
      b: clampColorChannel(options.backgroundColor?.b ?? 0),
      a: clampColorChannel(options.backgroundColor?.a ?? 0),
    };

    // Assume frames have alpha channel (common for WebCodecs output)
    const hasAlpha = options.hasAlpha ?? true;

    logger.info('performance', 'Starting WebP muxing', {
      frameCount: frames.length,
      width,
      height,
      loopCount,
      hasAlpha,
    });

    // Build chunks
    const vp8xChunk = createVP8XChunk(width, height, hasAlpha);
    const animChunk = createANIMChunk(backgroundColor, loopCount);
    const anmfChunks = frames.map((frame) =>
      createANMFChunk(frame.data, frame.duration, width, height)
    );

    // Calculate total size
    const webpPayloadSize =
      vp8xChunk.length +
      animChunk.length +
      anmfChunks.reduce((sum, chunk) => sum + chunk.length, 0);

    // RIFF header
    const riffHeader = new Uint8Array(12);
    riffHeader.set(writeFourCC('RIFF'), 0);
    riffHeader.set(writeUint32LE(4 + webpPayloadSize), 4); // File size - 8 (RIFF header)
    riffHeader.set(writeFourCC('WEBP'), 8);

    // Combine all chunks
    const totalSize = riffHeader.length + webpPayloadSize;
    const result = concatChunks([riffHeader, vp8xChunk, animChunk, ...anmfChunks], totalSize);

    logger.info('performance', 'WebP muxing completed', {
      frameCount: frames.length,
      outputSize: result.byteLength,
    });

    // Ensure the returned type is an ArrayBuffer (SharedArrayBuffer is not expected here)
    return result.buffer as ArrayBuffer;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('general', 'WebP muxing failed', { error: message, frameCount: frames.length });
    throw error;
  }
}
