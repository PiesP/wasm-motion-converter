import type { ModernGifOptions } from '../services/modern-gif-service';

export type EncoderOptions = ModernGifOptions;

export interface EncoderWorkerAPI {
  encode(frames: ImageData | ImageData[], options: EncoderOptions): Promise<Blob>;
  terminate(): void;
}

export interface WorkerPoolOptions {
  maxWorkers?: number;
  lazyInit?: boolean;
}
