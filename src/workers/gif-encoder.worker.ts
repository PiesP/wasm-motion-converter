import * as Comlink from 'comlink';
import { type ModernGifOptions, ModernGifService } from '../services/modern-gif-service';

// Serializable representation of ImageData that can be transferred via postMessage
export interface SerializableImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  colorSpace?: PredefinedColorSpace;
}

const api = {
  async encode(
    frames: SerializableImageData | SerializableImageData[],
    options: ModernGifOptions
  ): Promise<Blob> {
    // Convert serializable frames to ImageData
    const frameArray = Array.isArray(frames) ? frames : [frames];
    const imageDataFrames = frameArray.map((frame) => {
      // Create a copy of the data to ensure it's a regular ArrayBuffer, not SharedArrayBuffer
      const data = new Uint8ClampedArray(frame.data);
      return new ImageData(data, frame.width, frame.height, { colorSpace: frame.colorSpace });
    });
    return await ModernGifService.encode(imageDataFrames, options);
  },
  terminate() {
    self.close();
  },
};

Comlink.expose(api);
