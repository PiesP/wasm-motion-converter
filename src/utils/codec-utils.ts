// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Codec Utils
 *
 * Pure helpers for normalizing and classifying codec strings.
 */

import type { ConversionFormat } from '@t/conversion-types';
import { CONVERSION_FORMATS } from '@t/conversion-types';
import {
  COMPLEX_CODECS,
  FFMPEG_DECODE_UNSUPPORTED_CODECS,
  FFMPEG_PREFERRED_CODECS,
  WEBCODECS_NATIVE_CODECS,
} from '@utils/constants';

export function normalizeCodecString(codec: string | undefined): string {
  return (codec ?? '').trim().toLowerCase();
}

/**
 * Type guard: check whether a string is a supported ConversionFormat.
 */
export function isSupportedFormat(format: string): format is ConversionFormat {
  return (CONVERSION_FORMATS as readonly string[]).includes(format);
}

export function isAv1Codec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return c === 'av1' || c.startsWith('av01') || c.includes('av1');
}

export function isH264Codec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return (
    c === 'h264' ||
    c === 'h.264' ||
    c === 'h-264' ||
    c.includes('avc') ||
    c.startsWith('avc1') ||
    c.startsWith('avc3')
  );
}

export function isHevcCodec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return (
    c === 'hevc' ||
    c === 'h265' ||
    c === 'h.265' ||
    c === 'h-265' ||
    c.startsWith('hvc1') ||
    c.startsWith('hev1')
  );
}

export function isVp8Codec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return c === 'vp8' || c.includes('vp08') || c.includes('vp8');
}

export function isVp9Codec(codec: string | undefined): boolean {
  const c = normalizeCodecString(codec);
  return c === 'vp9' || c.includes('vp09') || c.includes('vp9');
}

/**
 * Check whether a codec is "complex" (requires direct WebCodecs frame extraction
 * to avoid double-transcoding overhead).
 *
 * Complex codecs are enumerated in `COMPLEX_CODECS` (e.g., AV1, VP9, HEVC).
 */
export function isComplexCodec(codec?: string): boolean {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = normalizeCodecString(codec);
  return COMPLEX_CODECS.some((entry) => normalized.includes(entry));
}

/**
 * Map a generic codec name or RFC 6381 codec string to concrete RFC 6381
 * candidates suitable for `VideoDecoder.isConfigSupported()` and
 * `canPlayType()` probes.
 *
 * - If the input already looks like an RFC 6381 string (e.g., `avc1.4D401E`,
 *   `av01.0.05M.08`, `vp09.00.10.08`, `hvc1.1.6.L93.B0`), it is returned
 *   first verbatim, followed by family-default candidates.
 * - Returns an empty array for unrecognised input.
 *
 * @example
 *   getCodecCandidates('av1')             // ['av01.0.05M.08', 'av01.0.08M.08', 'av01.0.08M.10']
 *   getCodecCandidates('h264')            // ['avc1.42E01E', 'avc1.4D401E', 'avc1.640028']
 *   getCodecCandidates('avc1.4D401F')     // ['avc1.4D401F', 'avc1.42E01E', 'avc1.4D401E', 'avc1.640028']
 */
export function getCodecCandidates(codec: string): string[] {
  const raw = codec.trim();
  const normalized = raw.toLowerCase();
  const candidates: string[] = [];

  // RFC 6381-ish passthrough, tried first.
  if (/^(av01|vp09|vp08|avc1|avc3|hvc1|hev1)(\.|$)/.test(normalized)) {
    candidates.push(raw);
  }

  if (isAv1Codec(normalized)) {
    candidates.push('av01.0.05M.08', 'av01.0.08M.08', 'av01.0.08M.10');
  }
  if (isHevcCodec(normalized)) {
    candidates.push('hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0');
  }
  if (isH264Codec(normalized)) {
    candidates.push('avc1.42E01E', 'avc1.4D401E', 'avc1.640028');
  }
  if (isVp9Codec(normalized)) {
    candidates.push('vp09.00.10.08', 'vp9');
  }
  if (isVp8Codec(normalized)) {
    candidates.push('vp8', 'vp08.00.10.08');
  }

  // Deduplicate while preserving order.
  return [...new Set(candidates)];
}

/**
 * Check whether a codec can be decoded via WebCodecs with good browser support.
 * Uses the WEBCODECS_NATIVE_CODECS list based on 2026 browser support data.
 *
 * @param codec - Codec name or RFC 6381 string
 * @returns True if codec has reliable WebCodecs support
 */
export function isWebCodecsNativeCodec(codec: string | undefined): boolean {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = normalizeCodecString(codec);
  return WEBCODECS_NATIVE_CODECS.some(
    (entry) => normalized === entry || normalized.startsWith(entry)
  );
}

/**
 * Check whether a codec should prefer FFmpeg WASM path over WebCodecs.
 * These codecs have poor or inconsistent WebCodecs browser support.
 *
 * @param codec - Codec name or RFC 6381 string
 * @returns True if FFmpeg path is preferred
 */
export function isFFmpegPreferredCodec(codec: string | undefined): boolean {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = normalizeCodecString(codec);
  return FFMPEG_PREFERRED_CODECS.some(
    (entry) => normalized === entry || normalized.includes(entry)
  );
}

/**
 * Check whether a codec is natively decodable by FFmpeg WASM.
 * Codecs in FFMPEG_DECODE_UNSUPPORTED_CODECS must use browser software decode
 * (<video> + Canvas) as a preprocessing step.
 */
export function isFFmpegDecodeUnsupportedCodec(codec: string | undefined): boolean {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = normalizeCodecString(codec);
  return FFMPEG_DECODE_UNSUPPORTED_CODECS.some(
    (entry) => normalized === entry || normalized.startsWith(entry)
  );
}

/**
 * Get the optimal conversion path for a given codec and format.
 * Returns 'gpu' for WebCodecs-native codecs, 'cpu' for FFmpeg-preferred,
 * and 'auto' for unknown codecs (runtime probe needed).
 *
 * @param codec - Codec name or RFC 6381 string
 * @param format - Output format (gif or webp)
 * @returns Recommended path: 'gpu' | 'cpu' | 'auto'
 */
export function getOptimalPath(
  codec: string | undefined,
  _format?: ConversionFormat
): 'gpu' | 'cpu' | 'auto' {
  if (!codec || codec === 'unknown') {
    return 'auto';
  }
  if (isFFmpegPreferredCodec(codec)) {
    return 'cpu';
  }
  if (isWebCodecsNativeCodec(codec)) {
    return 'gpu';
  }
  return 'auto';
}
