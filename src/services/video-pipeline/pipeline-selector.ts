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
  PipelineType,
  VideoCapabilities,
  VideoTrackInfo,
} from '@t/video-pipeline-types';
import { VideoPipelineSelectionError } from '@t/video-pipeline-types';
import { isAv1Codec, isH264Codec, isHevcCodec } from '@utils/codec-utils';
import { isDemuxableContainer } from '@utils/container-utils';

export function selectPipeline(
  caps: VideoCapabilities,
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

  // For other codecs (VP8/VP9/unknown), use a conservative heuristic:
  // - If the browser supports ANY of the probed codecs via WebCodecs, assume WebCodecs is usable.
  const anyWebCodecsDecode = caps.h264 || caps.hevc || caps.av1;

  if (anyWebCodecsDecode) {
    return caps.hardwareAccelerated ? 'webcodecs-hw' : 'webcodecs-sw';
  }

  return 'ffmpeg-wasm-full';
}
