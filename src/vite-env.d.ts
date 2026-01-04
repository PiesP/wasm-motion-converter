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

interface MediaStreamTrackProcessor<T = VideoFrame> {
  readonly readable: ReadableStream<T>;
}

declare var MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (options: { track: MediaStreamTrack }): MediaStreamTrackProcessor;
};

type ImageEncoder = Record<string, never>;

declare var ImageEncoder: {
  prototype: ImageEncoder;
  new (...args: never[]): ImageEncoder;
};

// HTMLMediaElement captureStream extension
declare global {
  interface HTMLMediaElement {
    captureStream?(): MediaStream;
  }
}
