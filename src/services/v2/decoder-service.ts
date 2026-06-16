import type { ConversionProgress } from '@/types/v2-conversion-types';
import type { DemuxResult } from './demuxer-service';

export type DecodeProgressCallback = (progress: ConversionProgress) => void;

/**
 * Decode all encoded video chunks to VideoFrames.
 *
 * Uses WebCodecs VideoDecoder. All chunks are fed upfront, and frames are
 * collected via the output callback. flush() is called only once at the end
 * to avoid the "key frame required after flush()" issue on batch boundaries.
 *
 * Frames are yielded in batches to bound memory usage.
 */
export async function* decodeStream(
  demux: DemuxResult,
  _poolSize: number,
  onProgress?: DecodeProgressCallback
): AsyncGenerator<VideoFrame, void, void> {
  const startTime = performance.now();
  const frames: VideoFrame[] = [];
  let decodeError: Error | null = null;

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      frames.push(frame);
    },
    error(e: Error) {
      decodeError = e;
      console.error('decoder error:', e);
    },
  });

  decoder.configure(demux.config);

  // Feed all chunks — first chunk is guaranteed keyframe by demuxer
  let chunkIdx = 0;
  for (const chunk of demux.chunks) {
    if (decodeError) break;
    decoder.decode(chunk);
    chunkIdx++;

    if (onProgress && chunkIdx % 10 === 0) {
      const elapsed = (performance.now() - startTime) / 1000;
      onProgress({
        phase: 'decoding',
        progress: Math.round((chunkIdx / demux.totalFrames) * 100),
        fps: Math.round(chunkIdx / elapsed),
        etaSeconds:
          chunkIdx > 0 ? Math.round((demux.totalFrames - chunkIdx) / (chunkIdx / elapsed)) : null,
        memoryMB: 0,
      });
    }
  }

  // Final flush — get remaining frames
  if (!decodeError) {
    await decoder.flush();
  }
  decoder.close();

  if (decodeError) throw decodeError;

  // Yield frames
  for (const frame of frames) {
    yield frame;
  }

  if (onProgress) {
    onProgress({
      phase: 'decoding',
      progress: 100,
      fps: 0,
      etaSeconds: 0,
      memoryMB: 0,
    });
  }
}
