/**
 * Codec Capabilities Module
 *
 * Defines which conversion paths (WebCodecs, FFmpeg, or both) support each codec.
 * This enables intelligent routing to avoid futile conversion attempts.
 */

export type ConversionPath = 'webcodecs-only' | 'ffmpeg-only' | 'both' | 'unsupported';

/**
 * Codec capability mapping
 *
 * Based on real-world test results:
 * - H.264 → GIF (FFmpeg): 2.04s ⚡ (3x faster than WebCodecs hybrid)
 * - H.264 → WebP (FFmpeg): 5.43s (2x faster than WebCodecs)
 * - AV1 → GIF (WebCodecs + modern-gif): 13.94s (FFmpeg lacks decoder)
 * - AV1 → WebP (WebCodecs 2-pass): 12.44s (FFmpeg lacks decoder)
 *
 * - 'webcodecs-only': Codec can ONLY be decoded by WebCodecs (e.g., AV1 - FFmpeg.wasm lacks decoder)
 * - 'ffmpeg-only': Codec can ONLY be decoded by FFmpeg (e.g., legacy codecs)
 * - 'both': Codec supported by both WebCodecs and FFmpeg (prefer FFmpeg for GIF/WebP performance)
 * - 'unsupported': Codec not supported by either path
 */
const CODEC_CAPABILITIES: Record<string, ConversionPath> = {
  // === AV1 - WebCodecs only (FFmpeg.wasm v5.1.4 lacks libaom/libdav1d) ===
  av1: 'webcodecs-only',
  av01: 'webcodecs-only',
  'av1.0': 'webcodecs-only',

  // === HEVC/H.265 - Both paths supported (FFmpeg preferred for performance) ===
  hevc: 'both',
  h265: 'both',
  'h.265': 'both',
  hvc1: 'both',
  hev1: 'both',

  // === VP9 - Both paths supported (FFmpeg preferred for performance) ===
  vp9: 'both',
  vp09: 'both',
  'vp9.0': 'both',

  // === VP8 - Both paths supported (FFmpeg preferred for performance) ===
  vp8: 'both',
  vp08: 'both',
  'vp8.0': 'both',

  // === H.264/AVC - Both paths supported (FFmpeg preferred for performance) ===
  h264: 'both',
  'h.264': 'both',
  avc1: 'both',
  avc3: 'both',
  avc: 'both',
  'avc1.42': 'both', // Baseline profile
  'avc1.4d': 'both', // Main profile
  'avc1.64': 'both', // High profile
};

/**
 * Get the conversion path capability for a given codec
 *
 * @param codec - Codec string (e.g., 'av1', 'h264', 'hevc')
 * @returns ConversionPath indicating which paths support this codec
 */
export function getCodecCapability(codec: string | undefined): ConversionPath {
  if (!codec || codec === 'unknown') {
    // Unknown codec: Try both paths with fallback
    return 'both';
  }

  const normalizedCodec = codec.toLowerCase().trim();

  // Direct lookup
  const directMatch = CODEC_CAPABILITIES[normalizedCodec];
  if (directMatch) {
    return directMatch;
  }

  // Partial match (e.g., "avc1.42E01E" → "avc1")
  for (const [key, capability] of Object.entries(CODEC_CAPABILITIES)) {
    if (normalizedCodec.includes(key)) {
      return capability;
    }
  }

  // Unknown codec: Try both paths as fallback
  return 'both';
}

/**
 * Check if a codec can be decoded by FFmpeg.wasm
 *
 * @param codec - Codec string
 * @returns true if FFmpeg can decode, false otherwise
 */
export function canFFmpegDecode(codec: string | undefined): boolean {
  const capability = getCodecCapability(codec);
  return capability === 'both' || capability === 'ffmpeg-only';
}

/**
 * Check if a codec can be decoded by WebCodecs
 *
 * Note: This checks theoretical capability, not browser support.
 * Use webcodecs-support.ts for actual browser capability detection.
 *
 * @param codec - Codec string
 * @returns true if WebCodecs supports this codec (in theory), false otherwise
 */
export function canWebCodecsDecode(codec: string | undefined): boolean {
  const capability = getCodecCapability(codec);
  return capability === 'both' || capability === 'webcodecs-only';
}

/**
 * Check if a codec requires WebCodecs exclusively
 *
 * @param codec - Codec string
 * @returns true if codec MUST use WebCodecs (FFmpeg cannot decode), false otherwise
 */
export function requiresWebCodecs(codec: string | undefined): boolean {
  return getCodecCapability(codec) === 'webcodecs-only';
}

/**
 * Get a human-readable error message for unsupported codec scenarios
 *
 * @param codec - Codec string
 * @param webCodecsAvailable - Whether WebCodecs is available in browser
 * @returns Error message or null if conversion is possible
 */
export function getCodecErrorMessage(
  codec: string | undefined,
  webCodecsAvailable: boolean
): string | null {
  const capability = getCodecCapability(codec);

  if (capability === 'unsupported') {
    return `Codec "${codec}" is not supported. Please convert the video to H.264, HEVC, or VP9 first.`;
  }

  if (capability === 'webcodecs-only' && !webCodecsAvailable) {
    return `${codec?.toUpperCase()} codec requires WebCodecs API which is not available in your browser. Please use a modern browser (Chrome 94+, Edge 94+) or convert the video to H.264 first.`;
  }

  if (capability === 'ffmpeg-only') {
    // Currently no ffmpeg-only codecs, but future-proofing
    return null;
  }

  return null;
}
