import type { ModernGifOptions } from '../services/modern-gif-service';
import type { SquooshWebPOptions } from '../services/squoosh-webp-service';

export type EncoderOptions = ModernGifOptions | SquooshWebPOptions;

export interface EncoderWorkerAPI {
  encode(frames: ImageData | ImageData[], options: EncoderOptions): Promise<Blob>;
  terminate(): void;
}

export interface WorkerPoolOptions {
  maxWorkers?: number;
  lazyInit?: boolean;
}
