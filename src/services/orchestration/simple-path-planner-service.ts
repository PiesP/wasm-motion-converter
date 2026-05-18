import {
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from '@services/webcodecs-support-service';
import type { ConversionFormat, VideoMetadata } from '@t/conversion-types';
import { isAv1Codec, isHevcCodec, isSupportedFormat, isVp9Codec } from '@utils/codec-utils';

import type { PathSelection } from './types-service';

type SimplePathPlanParams = {
  file: File;
  format: ConversionFormat;
  metadata?: VideoMetadata;
  abortSignal?: AbortSignal;
};

import { throwIfAborted } from '@utils/cancellation-context';

function checkAborted(abortSignal?: AbortSignal): void {
  if (abortSignal) {
    throwIfAborted(abortSignal);
  }
}

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

  checkAborted(abortSignal);

  const codecSupported = await isWebCodecsCodecSupported(codec, file.type, metadata);

  checkAborted(abortSignal);

  if (!codecSupported) {
    return {
      path: 'cpu',
      reason: 'WebCodecs does not support this codec, using FFmpeg CPU path',
    };
  }

  if (format === 'webp') {
    return {
      path: 'gpu',
      reason: 'WebP uses WebCodecs when codec support is available',
    };
  }

  if (shouldPreferGpuGif(codec)) {
    return {
      path: 'gpu',
      reason: 'Complex GIF input uses WebCodecs decode before FFmpeg fallback',
    };
  }

  return {
    path: 'cpu',
    reason: 'GIF defaults to the FFmpeg CPU path',
  };
}
