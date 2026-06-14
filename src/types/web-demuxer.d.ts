// SPDX-License-Identifier: MIT
// Type declarations for web-demuxer (UMD package, no @types/web-demuxer available)
// Matches WebDemuxerInstance in webm-demuxer-service.ts
declare module 'web-demuxer' {
  export class WebDemuxer {
    constructor(buffer: ArrayBuffer);
    destroy(): void;
    getVideoDecoderConfig(): Promise<{
      codec: string;
      codedWidth?: number;
      codedHeight?: number;
      description?: Uint8Array;
    } | null>;
    readVideoSample(index: number): Promise<{
      type: string;
      timestamp?: number;
      duration?: number;
      data: ArrayBuffer | Uint8Array;
    } | null>;
    readonly duration?: number;
    readonly videoSampleCount?: number;
    close?(): void;
  }
}
