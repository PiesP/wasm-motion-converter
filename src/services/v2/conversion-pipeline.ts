import { demuxVideo } from './demuxer-service';
import { decodeStream } from './decoder-service';
import { encodeGif } from './gif-encoder-service';
import { encodeWebp } from './webp-encoder-service';
import type { ConversionRequest, ConversionProgress } from '@/types/v2-conversion-types';

export type PipelineProgressCallback = (progress: ConversionProgress) => void;

export async function runConversionPipeline(
  request: ConversionRequest,
  onProgress: PipelineProgressCallback,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  // Phase 1: Demux (0~10%)
  onProgress({ phase: 'decoding', progress: 0, fps: 0, etaSeconds: null, memoryMB: 0 });
  const demuxResult = await demuxVideo(request);
  onProgress({ phase: 'decoding', progress: 5, fps: 0, etaSeconds: null, memoryMB: 0 });

  // Phase 2: Decode (10~30%)
  const codedWidth = demuxResult.config.codedWidth!;
  const codedHeight = demuxResult.config.codedHeight!;
  const poolSize = Math.min(30, Math.floor((request.maxMemoryMB * 1024 * 1024) / (codedWidth * codedHeight * 4)));
  const frameStream = decodeStream(demuxResult, poolSize, (p) => {
    const mappedProgress = 10 + Math.round(p.progress * 0.2); // 10→30%
    onProgress({ ...p, progress: mappedProgress });
  });

  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  // Phase 3: Encode (30~90%)

  let output: ArrayBuffer;
  if (request.format === 'gif') {
    output = (await encodeGif(frameStream, {
      width: codedWidth,
      height: codedHeight,
      quality: request.quality,
      scale: request.scale,
    }, (p) => {
      const mappedProgress = 30 + Math.round(p.fps * 0.6 / 100);
      onProgress({ ...p, progress: Math.min(90, mappedProgress) });
    })).buffer as ArrayBuffer;
  } else {
    const encoded = await encodeWebp(frameStream, {
      width: codedWidth,
      height: codedHeight,
      quality: request.quality,
      scale: request.scale,
    }, (p) => {
      const mappedProgress = 30 + Math.round(p.progress * 0.6);
      onProgress({ ...p, progress: Math.min(90, mappedProgress) });
    });
    output = encoded.buffer as ArrayBuffer;
  }

  // Phase 4: Assembly (90~100%)
  onProgress({ phase: 'assembling', progress: 95, fps: 0, etaSeconds: 0, memoryMB: 0 });
  onProgress({ phase: 'assembling', progress: 100, fps: 0, etaSeconds: 0, memoryMB: 0 });

  return output;
}
