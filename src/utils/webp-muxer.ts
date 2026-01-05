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
 */

export interface AnimatedWebPOptions {
  width: number;
  height: number;
  loopCount: number; // 0 = infinite
  backgroundColor: { r: number; g: number; b: number; a: number };
  hasAlpha?: boolean;
}

export interface WebPFrame {
  data: ArrayBuffer; // Encoded WebP frame
  duration: number; // Duration in milliseconds
}

const MAX_24BIT = 0xffffff; // 24-bit unsigned integer max
const MIN_DURATION_MS = 1;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = MAX_24BIT + 1; // Stored as (value - 1) in bitstream

const clamp24Bit = (value: number, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) {
    return fallback;
  }
  return Math.min(MAX_24BIT, Math.round(value));
};

const normalizeDuration = (duration: number): number =>
  clamp24Bit(Math.max(MIN_DURATION_MS, duration), MIN_DURATION_MS);

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

const clampColorChannel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

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
 * Write a 32-bit little-endian integer
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
 * Write a 24-bit little-endian integer
 */
function writeUint24LE(value: number): Uint8Array {
  const buffer = new Uint8Array(3);
  buffer[0] = value & 0xff;
  buffer[1] = (value >> 8) & 0xff;
  buffer[2] = (value >> 16) & 0xff;
  return buffer;
}

/**
 * Write a FourCC identifier (4 ASCII characters)
 */
function writeFourCC(fourcc: string): Uint8Array {
  const buffer = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    buffer[i] = fourcc.charCodeAt(i);
  }
  return buffer;
}

/**
 * Create VP8X (Extended Format) chunk
 * Flags: 0x10 (ANIMATION_FLAG) | 0x08 (ALPHA_FLAG if needed)
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
 */
function createANMFChunk(
  frameData: ArrayBuffer,
  duration: number,
  width: number,
  height: number
): Uint8Array {
  const frameBytes = new Uint8Array(frameData);
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
 * Mux individually encoded WebP frames into an animated WebP
 */
export async function muxAnimatedWebP(
  frames: WebPFrame[],
  options: AnimatedWebPOptions
): Promise<ArrayBuffer> {
  if (frames.length === 0) {
    throw new Error('No frames provided for animated WebP');
  }

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

  // Build chunks
  const vp8xChunk = createVP8XChunk(width, height, hasAlpha);
  const animChunk = createANIMChunk(backgroundColor, loopCount);
  const anmfChunks = frames.map((frame) =>
    createANMFChunk(frame.data, frame.duration, width, height)
  );

  // Calculate total size
  const webpPayloadSize =
    vp8xChunk.length + animChunk.length + anmfChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  // RIFF header
  const riffHeader = new Uint8Array(12);
  riffHeader.set(writeFourCC('RIFF'), 0);
  riffHeader.set(writeUint32LE(4 + webpPayloadSize), 4); // File size - 8 (RIFF header)
  riffHeader.set(writeFourCC('WEBP'), 8);

  // Combine all chunks
  const totalSize = riffHeader.length + webpPayloadSize;
  const result = concatChunks([riffHeader, vp8xChunk, animChunk, ...anmfChunks], totalSize);

  // Ensure the returned type is an ArrayBuffer (SharedArrayBuffer is not expected here)
  return result.buffer as ArrayBuffer;
}
