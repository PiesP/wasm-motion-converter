import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import type { ConversionRequest } from '@/types/v2-conversion-types';

export interface DemuxResult {
  chunks: EncodedVideoChunk[];
  config: VideoDecoderConfig;
  totalFrames: number;
  duration: number;
}

/**
 * Demux a video buffer using MediaBunny, extracting encoded video chunks
 * for the specified trim range.
 */
export async function demuxVideo(request: ConversionRequest): Promise<DemuxResult> {
  const source = new BufferSource(request.inputBuffer);

  const input = new Input({
    formats: ALL_FORMATS,
    source,
  });

  const videoTracks = await input.getVideoTracks();
  const videoTrack = videoTracks[0];
  if (!videoTrack) {
    input.dispose();
    throw new Error('No video track found in input buffer');
  }

  const config = await videoTrack.getDecoderConfig();
  if (!config) {
    input.dispose();
    throw new Error('Unable to obtain VideoDecoderConfig from video track');
  }

  const duration = await videoTrack.computeDuration();

  const sink = new EncodedPacketSink(videoTrack);

  // Start from the first keyframe — the VideoDecoder requires it after configure().
  // For trimStart > 0, find the nearest keyframe at-or-before trimStart.
  // For trimStart == 0, use the first packet (guaranteed to be decodable).
  const startPacket =
    request.trimStart > 0
      ? ((await sink.getKeyPacket(request.trimStart)) ?? (await sink.getPacket(0)))
      : await sink.getFirstPacket();
  if (!startPacket) {
    input.dispose();
    throw new Error('No decodable packets found in input buffer');
  }

  const endPacket = await sink.getPacket(request.trimEnd);

  const chunks: EncodedVideoChunk[] = [];
  let totalFrames = 0;

  for await (const packet of sink.packets(startPacket ?? undefined, endPacket ?? undefined)) {
    chunks.push(packet.toEncodedVideoChunk());
    totalFrames++;
  }

  input.dispose();

  return { chunks, config, totalFrames, duration };
}
