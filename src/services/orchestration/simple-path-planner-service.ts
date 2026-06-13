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
import { isAv1Codec, isHevcCodec, isSupportedFormat, isVp9Codec } from '@utils/codec-utils';
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

export async function selectSimplePath(params: SimplePathPlanParams): Promise<PathSelection> {
  const { file, format, metadata, abortSignal } = params;

  if (!isSupportedFormat(format)) {
    throw new Error(`Unsupported format: ${format}`);
  }

  const codec = metadata?.codec?.trim();
  if (!codec || codec === 'unknown') {
    // For GIF with modern-gif support, still use GPU path even without codec info
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
      reason: 'WebCodecs does not support this codec, using FFmpeg CPU path',
    };
  }

  // Both WebP and GIF use WebCodecs decode path when codec is supported
  if (format === 'webp') {
    return {
      path: 'gpu',
      reason: 'WebP uses WebCodecs decode → WebP muxer',
    };
  }

  // GIF: prefer GPU path (WebCodecs decode → modern-gif or FFmpeg palette)
  if (shouldPreferGpuGif(codec)) {
    return {
      path: 'gpu',
      reason: 'Complex GIF codec: WebCodecs decode → modern-gif encode',
    };
  }

  // Simple codec GIF with WebCodecs support: use GPU path with modern-gif
  if (isModernGifSupported()) {
    return {
      path: 'gpu',
      reason: 'GIF with modern-gif: WebCodecs decode → modern-gif encode',
    };
  }

  return {
    path: 'cpu',
    reason: 'GIF defaults to FFmpeg CPU path',
  };
}
