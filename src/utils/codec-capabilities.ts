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
 * - 'webcodecs-only': Codec can ONLY be decoded by WebCodecs (e.g., AV1 - FFmpeg.wasm lacks decoder)
 * - 'ffmpeg-only': Codec can ONLY be decoded by FFmpeg (e.g., legacy codecs)
 * - 'both': Codec supported by both WebCodecs and FFmpeg (e.g., H.264, HEVC, VP9)
 * - 'unsupported': Codec not supported by either path
 */
const CODEC_CAPABILITIES: Record<string, ConversionPath> = {
  // AV1 - WebCodecs only (FFmpeg.wasm v5.1.4 lacks libaom/libdav1d)
  av1: 'webcodecs-only',
  av01: 'webcodecs-only',

  // AVIF - WebCodecs ImageEncoder for static image encoding
  avif: 'webcodecs-only',

  // HEVC/H.265 - Both paths supported
  hevc: 'both',
  h265: 'both',
  'h.265': 'both',
  hvc1: 'both',
  hev1: 'both',

  // VP9 - Both paths supported
  vp9: 'both',
  vp09: 'both',

  // VP8 - Both paths supported
  vp8: 'both',
  vp08: 'both',

  // H.264/AVC - Both paths supported
  h264: 'both',
  'h.264': 'both',
  avc1: 'both',
  avc3: 'both',
  avc: 'both',
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
