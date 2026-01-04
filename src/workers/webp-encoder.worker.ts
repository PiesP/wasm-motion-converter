import * as Comlink from 'comlink';
import { SquooshWebPService, type SquooshWebPOptions } from '../services/squoosh-webp-service';

const api = {
  async encode(frames: ImageData | ImageData[], options: SquooshWebPOptions): Promise<Blob> {
    // WebP service expects a single frame
    const frame = Array.isArray(frames) ? frames[0] : frames;
    if (!frame) {
      throw new Error('No frame provided for WebP encoding');
    }
    return await SquooshWebPService.encode(frame, options);
  },
  terminate() {
    self.close();
  },
};

Comlink.expose(api);
