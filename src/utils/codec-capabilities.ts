/**
 * Codec Capabilities Module
 *
 * Defines which conversion paths (WebCodecs, FFmpeg, or both) support each codec.
 * This enables intelligent routing to avoid futile conversion attempts and provides
 * performance-optimized path selection based on real-world benchmarks.
 */

/**
 * Conversion path options for codec support
 *
 * - `webcodecs-only`: Codec can ONLY be decoded by WebCodecs (e.g., AV1 - FFmpeg.wasm lacks decoder)
 * - `ffmpeg-only`: Codec can ONLY be decoded by FFmpeg (e.g., legacy codecs)
 * - `both`: Codec supported by both WebCodecs and FFmpeg (prefer FFmpeg for GIF/WebP performance)
 * - `unsupported`: Codec not supported by either path
 */
export type ConversionPath = 'webcodecs-only' | 'ffmpeg-only' | 'both' | 'unsupported';

/**
 * Codec capability mapping based on real-world test results
 *
 * Performance benchmarks:
 * - H.264 → GIF (FFmpeg): 2.04s ⚡ (3x faster than WebCodecs hybrid)
 * - H.264 → WebP (FFmpeg): 5.43s (2x faster than WebCodecs)
 * - VP9 → WebP (WebCodecs with auto-scale+JPEG): 40-60s (after GPU stall fixes)
 * - AV1 → GIF (WebCodecs + modern-gif): 13.94s (FFmpeg lacks decoder)
 * - AV1 → WebP (WebCodecs 2-pass): 12.44s (FFmpeg lacks decoder)
 *
 * Path selection strategy:
 * - AV1: WebCodecs only (FFmpeg.wasm v5.1.4 lacks libaom/libdav1d)
 * - HEVC/VP8/VP9/H.264: Both paths supported, FFmpeg preferred for performance
 * - VP9: WebCodecs supported but requires 25% scale reduction + JPEG format for GPU stability
 * - Unknown codecs: Default to 'both' with fallback logic
 *
 * WebCodecs VP9 optimizations (canvas encoding bottleneck):
 * - Automatic 25% scale reduction (0.75x) when scale >= 0.9
 * - Force JPEG encoding (5x faster than PNG for VP9 canvas ops)
 * - 5-second timeout on canvas.convertToBlob() to detect GPU stalls
 * - Fallback to FFmpeg if any timeout or stall occurs
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
 * Determines which conversion paths (WebCodecs, FFmpeg, or both) can handle the specified codec.
 * Uses direct lookup with fallback to partial matching for codec variants (e.g., "avc1.42E01E" → "avc1").
 *
 * @param codec - Codec string (e.g., 'av1', 'h264', 'hevc', 'avc1.42E01E')
 * @returns ConversionPath indicating which paths support this codec
 *
 * @example
 * ```ts
 * getCodecCapability('av1'); // 'webcodecs-only'
 * getCodecCapability('h264'); // 'both'
 * getCodecCapability('avc1.42E01E'); // 'both' (partial match to 'avc1')
 * getCodecCapability('unknown'); // 'both' (fallback)
 * ```
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
 * @param codec - Codec string (e.g., 'h264', 'hevc', 'vp9')
 * @returns `true` if FFmpeg can decode this codec, `false` otherwise
 *
 * @example
 * ```ts
 * canFFmpegDecode('h264'); // true (both)
 * canFFmpegDecode('av1'); // false (webcodecs-only)
 * canFFmpegDecode('hevc'); // true (both)
 * ```
 */
export function canFFmpegDecode(codec: string | undefined): boolean {
  const capability = getCodecCapability(codec);
  return capability === 'both' || capability === 'ffmpeg-only';
}

/**
 * Check if a codec can be decoded by WebCodecs
 *
 * Note: This checks theoretical capability based on codec specifications, not actual browser support.
 * Use `webcodecs-support-service.ts` for runtime browser capability detection.
 *
 * @param codec - Codec string (e.g., 'av1', 'h264', 'vp9')
 * @returns `true` if WebCodecs supports this codec (in theory), `false` otherwise
 *
 * @example
 * ```ts
 * canWebCodecsDecode('av1'); // true (webcodecs-only)
 * canWebCodecsDecode('h264'); // true (both)
 * canWebCodecsDecode('unknown'); // true (both - fallback)
 * ```
 */
export function canWebCodecsDecode(codec: string | undefined): boolean {
  const capability = getCodecCapability(codec);
  return capability === 'both' || capability === 'webcodecs-only';
}

/**
 * Check if a codec requires WebCodecs exclusively
 *
 * Identifies codecs that cannot be decoded by FFmpeg.wasm and must use WebCodecs
 * (e.g., AV1 due to missing libaom/libdav1d in FFmpeg.wasm v5.1.4).
 *
 * @param codec - Codec string (e.g., 'av1', 'av01')
 * @returns `true` if codec MUST use WebCodecs (FFmpeg cannot decode), `false` otherwise
 *
 * @example
 * ```ts
 * requiresWebCodecs('av1'); // true (webcodecs-only)
 * requiresWebCodecs('h264'); // false (both)
 * requiresWebCodecs('hevc'); // false (both)
 * ```
 */
export function requiresWebCodecs(codec: string | undefined): boolean {
  return getCodecCapability(codec) === 'webcodecs-only';
}

/**
 * Get a human-readable error message for unsupported codec scenarios
 *
 * Generates user-friendly error messages when codec conversion is not possible due to:
 * - Unsupported codec (not in capability map)
 * - WebCodecs-only codec without browser support
 *
 * @param codec - Codec string (e.g., 'av1', 'unknown-codec')
 * @param webCodecsAvailable - Whether WebCodecs API is available in current browser
 * @returns Error message string if conversion is not possible, `null` if conversion can proceed
 *
 * @example
 * ```ts
 * getCodecErrorMessage('av1', false);
 * // 'AV1 codec requires WebCodecs API which is not available in your browser...'
 *
 * getCodecErrorMessage('h264', false);
 * // null (FFmpeg can handle it)
 *
 * getCodecErrorMessage('unknown-codec', true);
 * // null (will try both paths with fallback)
 * ```
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
