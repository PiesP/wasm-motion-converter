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

const FORCED_FFMPEG_CONTAINERS: ContainerFormat[] = ['avi', 'wmv'];

const requiresFfmpegForCodec = (codec: string, caps: ExtendedCapabilities): boolean => {
  if (isH264Codec(codec)) return !caps.h264;
  if (isHevcCodec(codec)) return !caps.hevc;
  if (isVp8Codec(codec)) return !caps.vp8;
  if (isVp9Codec(codec)) return !caps.vp9;
  return false;
};

const isKnownCodec = (codec: string): boolean =>
  isH264Codec(codec) ||
  isHevcCodec(codec) ||
  isAv1Codec(codec) ||
  isVp8Codec(codec) ||
  isVp9Codec(codec);

const createWebCodecsUnavailableError = (
  codec: string,
  container: ContainerFormat
): VideoPipelineSelectionError =>
  new VideoPipelineSelectionError({
    code: 'DecodingNotSupported',
    message: 'WebCodecs decode is not available in this browser.',
    context: {
      codec,
      container,
    },
  });

const createAv1UnavailableError = (
  codec: string,
  container: ContainerFormat
): VideoPipelineSelectionError =>
  new VideoPipelineSelectionError({
    code: 'DecodingNotSupported',
    message: 'AV1 decoding is not supported by WebCodecs in this browser.',
    context: {
      codec,
      container,
    },
  });

const selectWebcodecsPipeline = (caps: ExtendedCapabilities): PipelineType =>
  caps.hardwareAccelerated ? 'webcodecs-hw' : 'webcodecs-sw';

export function selectPipeline(
  caps: ExtendedCapabilities,
  track: VideoTrackInfo,
  container: ContainerFormat
): PipelineType {
  if (FORCED_FFMPEG_CONTAINERS.includes(container)) {
    return 'ffmpeg-wasm-full';
  }

  if (!isDemuxableContainer(container)) {
    return 'ffmpeg-wasm-full';
  }

  const codec = track.codec;

  if (!caps.webcodecsDecode) {
    if (isAv1Codec(codec)) {
      throw createWebCodecsUnavailableError(codec, container);
    }

    return 'ffmpeg-wasm-full';
  }

  if (isAv1Codec(codec)) {
    if (!caps.av1) {
      throw createAv1UnavailableError(codec, container);
    }

    return selectWebcodecsPipeline(caps);
  }

  if (requiresFfmpegForCodec(codec, caps)) {
    return 'ffmpeg-wasm-full';
  }

  if (!isKnownCodec(codec)) {
    return 'ffmpeg-wasm-full';
  }

  return selectWebcodecsPipeline(caps);
}
