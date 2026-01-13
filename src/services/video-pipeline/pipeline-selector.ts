/**
 * Pipeline Selector (pure)
 *
 * Selects the optimal decode pipeline based on:
 * - runtime capabilities
 * - container format
 * - track codec
 *
 * Rules:
 * - Progressive enhancement: WebCodecs HW → WebCodecs SW → FFmpeg.wasm
 * - AV1 MUST NOT fall back to FFmpeg.wasm if WebCodecs AV1 is unsupported.
 */

import type {
  ContainerFormat,
  ExtendedCapabilities,
  PipelineType,
  VideoTrackInfo,
} from '@t/video-pipeline-types';
import { VideoPipelineSelectionError } from '@t/video-pipeline-types';
import { isAv1Codec, isH264Codec, isHevcCodec, isVp8Codec, isVp9Codec } from '@utils/codec-utils';
import { isDemuxableContainer } from '@utils/container-utils';

export function selectPipeline(
  caps: ExtendedCapabilities,
  track: VideoTrackInfo,
  container: ContainerFormat
): PipelineType {
  // Forced full pipeline containers
  if (container === 'avi' || container === 'wmv') {
    return 'ffmpeg-wasm-full';
  }

  // Unknown or non-demuxable containers fall back to FFmpeg.
  if (!isDemuxableContainer(container)) {
    return 'ffmpeg-wasm-full';
  }

  const codec = track.codec;

  // If WebCodecs is not available at all, prefer the FFmpeg full pipeline.
  // AV1 must fail-fast to avoid extremely slow FFmpeg decode attempts.
  if (!caps.webcodecsDecode) {
    if (isAv1Codec(codec)) {
      throw new VideoPipelineSelectionError({
        code: 'DecodingNotSupported',
        message: 'WebCodecs decode is not available in this browser.',
        context: {
          codec,
          container,
        },
      });
    }

    return 'ffmpeg-wasm-full';
  }

  // AV1: fail-fast if WebCodecs AV1 decode is unavailable.
  if (isAv1Codec(codec)) {
    if (!caps.av1) {
      throw new VideoPipelineSelectionError({
        code: 'DecodingNotSupported',
        message: 'AV1 decoding is not supported by WebCodecs in this browser.',
        context: {
          codec,
          container,
        },
      });
    }

    return caps.hardwareAccelerated ? 'webcodecs-hw' : 'webcodecs-sw';
  }

  // Codec-aware gating based on probed capabilities.
  if (isH264Codec(codec) && !caps.h264) {
    return 'ffmpeg-wasm-full';
  }

  if (isHevcCodec(codec) && !caps.hevc) {
    return 'ffmpeg-wasm-full';
  }

  if (isVp8Codec(codec) && !caps.vp8) {
    return 'ffmpeg-wasm-full';
  }

  if (isVp9Codec(codec) && !caps.vp9) {
    return 'ffmpeg-wasm-full';
  }

  // For success/predictability: only take a WebCodecs pipeline when the codec is explicitly known.
  // Unknown codecs should prefer the FFmpeg full pipeline.
  const isKnownCodec =
    isH264Codec(codec) ||
    isHevcCodec(codec) ||
    isAv1Codec(codec) ||
    isVp8Codec(codec) ||
    isVp9Codec(codec);

  if (!isKnownCodec) {
    return 'ffmpeg-wasm-full';
  }

  return caps.hardwareAccelerated ? 'webcodecs-hw' : 'webcodecs-sw';
}
