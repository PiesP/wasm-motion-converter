// SPDX-License-Identifier: MIT
// Type declarations for mp4box (UMD package, no @types/mp4box available)
declare module 'mp4box' {
  export class ISOFile {
    constructor();
    appendBuffer(data: ArrayBuffer | Uint8Array): void;
    flush(): void;
    getInfo(): unknown;
    setSegmentOptions(trackId: number, user?: unknown, options?: unknown): void;
    unsetSegmentOptions(trackId: number): void;
    setExtractionOptions(trackId: number, user?: unknown, options?: unknown): void;
    unsetExtractionOptions(trackId: number): void;
    parse(): void;
    processSamples(): void;
    checkBuffer(data?: ArrayBuffer | Uint8Array): boolean;
    onReady?: (info: unknown) => void;
    onSamples?: (trackId: number, user: unknown, samples: unknown[]) => void;
    onError?: (error: Error) => void;
    static createFile(): ISOFile;
  }

  const mp4box: { ISOFile: typeof ISOFile };
  export default mp4box;
}
