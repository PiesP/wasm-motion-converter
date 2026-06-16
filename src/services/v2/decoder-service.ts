import { FrameRingBuffer } from './frame-pool';
import type { DemuxResult } from './demuxer-service';
import type { ConversionProgress } from '@/types/v2-conversion-types';

const BATCH_SIZE = 30;

export type DecodeProgressCallback = (progress: ConversionProgress) => void;

export async function* decodeStream(
  demux: DemuxResult,
  poolSize: number,
  onProgress?: DecodeProgressCallback
): AsyncGenerator<VideoFrame, void, void> {
  const ringBuffer = new FrameRingBuffer(poolSize);
  let decodedCount = 0;
  const startTime = performance.now();

  const decoder = new VideoDecoder({
    output(frame: VideoFrame) {
      ringBuffer.push(frame);
    },
    error(e: Error) {
      console.error('decoder error:', e);
    },
  });

  decoder.configure(demux.config);

  let chunkIdx = 0;
  for (const chunk of demux.chunks) {
    decoder.decode(chunk);
    chunkIdx++;

    if (chunkIdx % BATCH_SIZE === 0 || chunkIdx === demux.chunks.length) {
      await decoder.flush();

      while (!ringBuffer.isEmpty) {
        const frame = ringBuffer.shift();
        if (frame) {
          decodedCount++;
          yield frame;

          if (onProgress && decodedCount % 10 === 0) {
            const elapsed = (performance.now() - startTime) / 1000;
            const fps = decodedCount / elapsed;
            onProgress({
              phase: 'decoding',
              progress: Math.round((decodedCount / demux.totalFrames) * 100),
              fps: Math.round(fps),
              etaSeconds: fps > 0 ? Math.round((demux.totalFrames - decodedCount) / fps) : null,
              memoryMB: 0,
            });
          }
        }
      }
    }
  }

  decoder.close();
  ringBuffer.clear();

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
