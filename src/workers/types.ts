import type { ModernGifOptions } from '../services/modern-gif-service';
import type { SerializableImageData } from './gif-encoder.worker';

export type EncoderOptions = ModernGifOptions;

export interface EncoderWorkerAPI {
  encode(
    frames: SerializableImageData | SerializableImageData[],
    options: EncoderOptions
  ): Promise<Blob>;
  terminate(): void;
}

export interface WorkerPoolOptions {
  maxWorkers?: number;
  lazyInit?: boolean;
}
