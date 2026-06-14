// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Simple Path Planner
 *
 * Selects the conversion path (GPU/WebCodecs vs CPU/FFmpeg) based on
 * codec availability and browser capabilities.
 *
 * All GPU paths now use a unified streaming pipeline:
 * WebCodecs decode → FFmpeg VFS → FFmpeg encode
 */

import {
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from '@services/webcodecs-support-service';
import type { ConversionFormat, PathSelection, VideoMetadata } from '@t/conversion-types';
import { throwIfAborted } from '@utils/cancellation-context';
import {
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
 * 2. WebCodecs-native codecs (H.264, VP8/9, AV1, HEVC) → GPU path
 *    H.264: ~99% decode support — universal
 *    VP9:   ~97% decode support — all major browsers
 *    AV1:   ~91.5% decode — Chrome/Firefox/Safari 14+
 *    HEVC:  ~85% decode — Safari/Edge/Chrome (no Firefox)
 *
 *    All GPU paths: WebCodecs decode → FFmpeg VFS → FFmpeg encode
 *
 * 3. Unknown codecs → runtime probe (isWebCodecsCodecSupported)
 *
 * @returns PathSelection with 'gpu' or 'cpu' path and reason
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

  // WebCodecs-native codecs: use GPU path (WebCodecs decode → FFmpeg VFS → encode)
  if (isWebCodecsNativeCodec(codec)) {
    return {
      path: 'gpu',
      reason: `${format.toUpperCase()} + ${codec}: WebCodecs decode → FFmpeg VFS encode`,
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

  // Runtime probe succeeded: use GPU path
  return {
    path: 'gpu',
    reason: `${format.toUpperCase()} + ${codec}: WebCodecs decode → FFmpeg VFS encode (runtime probe)`,
  };
}
