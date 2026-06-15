// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Simple Path Planner
 *
 * Selects the conversion path based on codec availability and browser capabilities.
 *
 * Path selection strategy (2026 browser support data):
 *
 * 1. FFmpeg-preferred codecs (theora, vp6, mpeg4, etc.) → CPU path
 *    These codecs have no WebCodecs support, must use FFmpeg.
 *
 * 2. WebCodecs-native codecs (H.264, VP8/9, AV1, HEVC) → Software path
 *    H.264: ~99% decode support — universal
 *    VP9:   ~97% decode support — all major browsers
 *    AV1:   ~91.5% decode — Chrome/Firefox/Safari 14+
 *    HEVC:  ~85% decode — Safari/Edge/Chrome (no Firefox)
 *
 *    Software path: FrameExtractorService (GPU decode via createImageBitmap)
 *    → FFmpeg VFS → FFmpeg encode. Avoids slow FFmpeg WASM decode.
 *
 * 3. AV1/AV01 → Software Decode path
 *    FFmpeg WASM can't decode AV1 — uses <video> + Canvas, then FFmpeg encode.
 *
 * 4. Unknown codecs → runtime probe (isWebCodecsCodecSupported)
 */

import {
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from '@services/webcodecs-support-service';
import type { ConversionFormat, PathSelection, VideoMetadata } from '@t/conversion-types';
import { throwIfAborted } from '@utils/cancellation-context';
import {
  isFFmpegDecodeUnsupportedCodec,
  isFFmpegPreferredCodec,
  isSupportedFormat,
  isWebCodecsNativeCodec,
} from '@utils/codec-utils';

type SimplePathPlanParams = {
  file: File;
  format: ConversionFormat;
  metadata?: VideoMetadata;
  abortSignal?: AbortSignal;
};

/**
 * Select optimal conversion path based on codec capabilities and browser support.
 *
 * Path selection strategy (2026 browser support data):
 *
 * 1. FFmpeg-preferred codecs (theora, vp6, mpeg4, etc.) → CPU path
 *    These codecs have no WebCodecs support, must use FFmpeg.
 *
 * 2. WebCodecs-native codecs (H.264, VP8/9, AV1, HEVC) → Software path
 *    H.264: ~99% decode support — universal
 *    VP9:   ~97% decode support — all major browsers
 *    AV1:   ~91.5% decode — Chrome/Firefox/Safari 14+
 *    HEVC:  ~85% decode — Safari/Edge/Chrome (no Firefox)
 *
 *    All Software paths: FrameExtractorService (GPU decode) → FFmpeg VFS → FFmpeg encode
 *
 * 3. Unknown codecs → runtime probe (isWebCodecsCodecSupported)
 *
 * @returns PathSelection with 'software' or 'cpu' path and reason
 */
export async function selectSimplePath(params: SimplePathPlanParams): Promise<PathSelection> {
  const { file, format, metadata, abortSignal } = params;

  if (!isSupportedFormat(format)) {
    throw new Error(`Unsupported format: ${format}`);
  }

  const codec = metadata?.codec?.trim();

  // No codec info → CPU path (conservative)
  if (!codec || codec === 'unknown') {
    return {
      path: 'cpu',
      reason: 'Codec metadata is unavailable, using FFmpeg CPU path',
    };
  }

  // FFmpeg-preferred codecs: no WebCodecs support
  if (isFFmpegPreferredCodec(codec)) {
    return {
      path: 'cpu',
      reason: `FFmpeg-preferred codec: ${codec}`,
    };
  }

  // WebCodecs-native codecs: check if FFmpeg WASM can decode them
  if (isWebCodecsNativeCodec(codec)) {
    // FFmpeg WASM can't decode AV1/AV01 — need software decode via <video>
    if (isFFmpegDecodeUnsupportedCodec(codec)) {
      return {
        path: 'software',
        reason: `${format.toUpperCase()} + ${codec}: browser software decode → FFmpeg VFS encode`,
      };
    }
    return {
      path: 'software',
      reason: `${format.toUpperCase()} + ${codec}: GPU frame extraction → FFmpeg encode`,
    };
  }

  // Unknown codec: runtime probe required
  if (!isWebCodecsDecodeSupported()) {
    return {
      path: 'cpu',
      reason: 'WebCodecs decode is unavailable, using FFmpeg CPU path',
    };
  }

  if (abortSignal) throwIfAborted(abortSignal);

  const codecSupported = await isWebCodecsCodecSupported(codec, file.type, metadata);

  if (abortSignal) throwIfAborted(abortSignal);

  if (!codecSupported) {
    return {
      path: 'cpu',
      reason: `WebCodecs does not support codec: ${codec}`,
    };
  }

  // Runtime probe succeeded: use software path for GPU frame extraction
  return {
    path: 'software',
    reason: `${format.toUpperCase()} + ${codec}: GPU frame extraction → FFmpeg encode (runtime probe)`,
  };
}
