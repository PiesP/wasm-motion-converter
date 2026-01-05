/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Google AdSense
  readonly VITE_ADSENSE_PUBLISHER_ID?: string;
  readonly VITE_ENABLE_ADS?: string;
  // FFmpeg Debug
  readonly VITE_DEBUG_FFMPEG?: string;
  readonly VITE_DEBUG_APP?: string;
  readonly VITE_FFMPEG_HARD_TIMEOUT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
  maxBufferSize?: number;
}

interface MediaStreamTrackProcessor<T = VideoFrame> {
  readonly readable: ReadableStream<T>;
}

declare var MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (options: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor;
};

interface ImageEncoderInit {
  type: string;
  quality?: number;
  output: (chunk: { byteLength: number; copyTo: (destination: ArrayBufferView) => void }) => void;
  error?: (error: Error) => void;
}

interface ImageEncoder {
  encode(image: ImageBitmapSource): Promise<void> | void;
  flush(): Promise<void>;
  close(): void;
}

declare var ImageEncoder: {
  prototype: ImageEncoder;
  new (init: ImageEncoderInit): ImageEncoder;
  isTypeSupported?: (type: string) => Promise<boolean>;
};

// HTMLMediaElement captureStream extension
declare global {
  interface HTMLMediaElement {
    captureStream?(): MediaStream;
  }
}
