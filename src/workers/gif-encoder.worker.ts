import * as Comlink from 'comlink';
import { ModernGifService, type ModernGifOptions } from '../services/modern-gif-service';

const api = {
  async encode(frames: ImageData | ImageData[], options: ModernGifOptions): Promise<Blob> {
    // GIF service expects an array
    const frameArray = Array.isArray(frames) ? frames : [frames];
    return await ModernGifService.encode(frameArray, options);
  },
  terminate() {
    self.close();
  },
};

Comlink.expose(api);
