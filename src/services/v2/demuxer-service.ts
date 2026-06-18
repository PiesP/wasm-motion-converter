// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import type { ConversionRequest } from '@/types/v2-conversion-types';

export interface DemuxResult {
  chunks: EncodedVideoChunk[];
  config: VideoDecoderConfig;
  totalFrames: number;
  duration: number;
}

type DemuxProgressCallback = (packetsExtracted: number) => void;

/**
 * Demux a video buffer using MediaBunny, extracting encoded video chunks.
 */
export async function demuxVideo(
  request: ConversionRequest,
  onProgress?: DemuxProgressCallback
): Promise<DemuxResult> {
  const startTime = performance.now();
  const source = new BufferSource(request.inputBuffer);
  const input = new Input({ formats: ALL_FORMATS, source });

  const videoTracks = await input.getVideoTracks();
  const videoTrack = videoTracks[0];
  if (!videoTrack) {
    input.dispose();
    logger.error('demuxer', 'No video track found in input buffer', {
      fileName: request.fileName,
      fileSizeBytes: request.inputBuffer.byteLength,
    });
    throw new Error('No video track found in input buffer');
  }

  const config = await videoTrack.getDecoderConfig();
  if (!config) {
    input.dispose();
    logger.error('demuxer', 'Unable to obtain VideoDecoderConfig', {
      fileName: request.fileName,
      trackCount: videoTracks.length,
    });
    throw new Error('Unable to obtain VideoDecoderConfig from video track');
  }

  const duration = await videoTrack.computeDuration();
  const sink = new EncodedPacketSink(videoTrack);

  // Start from first packet (requires keyframe after configure)
  const startPacket = await sink.getFirstPacket();
  if (!startPacket) {
    input.dispose();
    logger.error('demuxer', 'No decodable packets found', {
      fileName: request.fileName,
      codec: config.codec,
      duration: `${duration.toFixed(2)}s`,
    });
    throw new Error('No decodable packets found in input buffer');
  }

  // trimEnd == 0 means "until the end" — use duration to get last packet
  let endPacket = startPacket;
  if (request.trimEnd > 0) {
    const trimmedEnd = await sink.getPacket(request.trimEnd);
    if (trimmedEnd) endPacket = trimmedEnd;
  } else {
    const lastPkt = await sink.getPacket(duration);
    if (lastPkt) endPacket = lastPkt;
  }

  const chunks: EncodedVideoChunk[] = [];
  let totalFrames = 0;

  logger.info('demuxer', 'Demuxing started', {
    fileName: request.fileName,
    fileSizeBytes: request.inputBuffer.byteLength,
    codec: config.codec,
    duration: `${duration.toFixed(2)}s`,
  });

  for await (const packet of sink.packets(startPacket, endPacket)) {
    chunks.push(packet.toEncodedVideoChunk());
    totalFrames++;
    if (onProgress && totalFrames % 10 === 0) {
      onProgress(totalFrames);
    }
  }

  input.dispose();

  const elapsed = performance.now() - startTime;
  logger.info('demuxer', 'Demuxing complete', {
    totalFrames,
    chunkCount: chunks.length,
    elapsedMs: Math.round(elapsed),
    elapsed: `${(elapsed / 1000).toFixed(2)}s`,
  });

  return { chunks, config, totalFrames, duration };
}
