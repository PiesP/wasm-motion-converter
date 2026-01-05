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

interface AnimatedWebPOptions {
  width: number;
  height: number;
  loopCount: number; // 0 = infinite
  backgroundColor: { r: number; g: number; b: number; a: number };
}

interface WebPFrame {
  data: ArrayBuffer; // Encoded WebP frame
  duration: number; // Duration in milliseconds
}

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

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Create ANIM (Animation) chunk
 */
function createANIMChunk(backgroundColor: { r: number; g: number; b: number; a: number }, loopCount: number): Uint8Array {
  const chunkSize = 6;

  const chunks: Uint8Array[] = [
    writeFourCC('ANIM'),
    writeUint32LE(chunkSize),
    new Uint8Array([
      backgroundColor.r,
      backgroundColor.g,
      backgroundColor.b,
      backgroundColor.a,
    ]),
    new Uint8Array([loopCount & 0xff, (loopCount >> 8) & 0xff]), // Loop count (16 bits)
  ];

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Create ANMF (Animation Frame) chunk
 */
function createANMFChunk(frameData: ArrayBuffer, duration: number, width: number, height: number): Uint8Array {
  const frameBytes = new Uint8Array(frameData);
  const frameSize = frameBytes.length;
  const chunkHeaderSize = 16; // ANMF header without frame data
  const chunkSize = chunkHeaderSize + frameSize;

  const chunks: Uint8Array[] = [
    writeFourCC('ANMF'),
    writeUint32LE(chunkSize),
    writeUint24LE(0), // Frame X (24 bits) - always 0 for full-frame
    writeUint24LE(0), // Frame Y (24 bits) - always 0 for full-frame
    writeUint24LE(width - 1), // Frame width - 1 (24 bits)
    writeUint24LE(height - 1), // Frame height - 1 (24 bits)
    writeUint24LE(duration), // Duration in milliseconds (24 bits)
    new Uint8Array([0]), // Flags: 0 = no blending, no disposal
    frameBytes, // Encoded frame data
  ];

  // Add padding byte if frame data size is odd
  if (frameSize % 2 === 1) {
    chunks.push(new Uint8Array([0]));
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
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

  const { width, height, loopCount, backgroundColor } = options;

  // Assume frames have alpha channel (common for WebCodecs output)
  const hasAlpha = true;

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
  const riffHeader = new Uint8Array([
    ...writeFourCC('RIFF'),
    ...writeUint32LE(4 + webpPayloadSize), // File size - 8 (RIFF header)
    ...writeFourCC('WEBP'),
  ]);

  // Combine all chunks
  const totalSize = riffHeader.length + webpPayloadSize;
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(riffHeader, offset);
  offset += riffHeader.length;

  result.set(vp8xChunk, offset);
  offset += vp8xChunk.length;

  result.set(animChunk, offset);
  offset += animChunk.length;

  for (const anmfChunk of anmfChunks) {
    result.set(anmfChunk, offset);
    offset += anmfChunk.length;
  }

  return result.buffer;
}
