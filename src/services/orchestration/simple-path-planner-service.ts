// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Simple Path Planner
 *
 * Selects the conversion path (GPU/WebCodecs vs CPU/FFmpeg codec availability and browser capabilities.
 */

import {
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from '@services/webcodecs-support-service';
import type { ConversionFormat, PathSelection, VideoMetadata } from '@t/conversion-types';
import { throwIfAborted } from '@utils/cancellation-context';
import {
  isAv1Codec,
  isHevcCodec,
  isSupportedFormat,
  isVp9Codec,
  isWebCodecsNativeCodec,
  isFFmpegPreferredCodec,
} from '@utils/codec-utils';
import { isModernGifSupported } from '@services/modern-gif-service';

type SimplePathPlanParams = {
  file: File;
  format: ConversionFormat;
  metadata?: VideoMetadata;
  abortSignal?: AbortSignal;
};

function shouldPreferGpuGif(codec: string): boolean {
  return isAv1Codec(codec) || isHevcCodec(codec) || isVp9Codec(codec);
}

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
 * 3. Unknown codecs → runtime probe (isWebCodecsCodecSupported)
 *
 * 4. GIF-specific: modern-gif available → always use GPU path
 *    modern-gif avoids 4.4s FFmpeg palette generation
 *
 * @returns PathSelection with 'gpu' or 'cpu' path and reason
 */
export async function selectSimplePath(params: SimplePathPlanParams): Promise<PathSelection> {
  const { file, format, metadata, abortSignal } = params;

  if (!isSupportedFormat(format)) {
    throw new Error(`Unsupported format: ${format}`);
  }

  const codec = metadata?.codec?.trim();

  // No codec info: use heuristics based on format and modern-gif support
  if (!codec || codec === 'unknown') {
    if (format === 'gif' && isModernGifSupported()) {
      return {
        path: 'gpu',
        reason: 'GIF with modern-gif: WebCodecs decode + modern-gif encode',
      };
    }
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

  // WebCodecs-native codecs: use GPU path
  if (isWebCodecsNativeCodec(codec)) {
    if (format === 'webp') {
      return {
        path: 'gpu',
        reason: `WebP + ${codec}: WebCodecs decode → WebP muxer`,
      };
    }
    // GIF with modern-gif
    if (isModernGifSupported()) {
      return {
        path: 'gpu',
        reason: `GIF + ${codec}: WebCodecs decode → modern-gif encode`,
      };
    }
    // GIF without modern-gif: use FFmpeg palette for complex codecs
    if (shouldPreferGpuGif(codec)) {
      return {
        path: 'gpu',
        reason: `GIF + ${codec}: WebCodecs decode → FFmpeg palette encode`,
      };
    }
    return {
      path: 'cpu',
      reason: `GIF + ${codec}: FFmpeg direct (no modern-gif)`,
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
  if (format === 'webp') {
    return {
      path: 'gpu',
      reason: `WebP + ${codec}: WebCodecs decode → WebP muxer (runtime probe)`,
    };
  }

  if (isModernGifSupported()) {
    return {
      path: 'gpu',
      reason: `GIF + ${codec}: WebCodecs decode → modern-gif encode (runtime probe)`,
    };
  }

  return {
    path: 'cpu',
    reason: `GIF + ${codec}: FFmpeg direct (runtime probe, no modern-gif)`,
  };
}
