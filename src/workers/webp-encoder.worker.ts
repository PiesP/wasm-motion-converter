import * as Comlink from 'comlink';

// WebP encoding via FFmpeg is now handled in the conversion service
// This worker is kept for potential future use with alternative WebP encoders
const api = {
  async encode(): Promise<Blob> {
    throw new Error('WebP encoding is now handled via FFmpeg in the main service');
  },
  terminate() {
    self.close();
  },
};

Comlink.expose(api);
