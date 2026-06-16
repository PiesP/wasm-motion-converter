export interface ConversionRequest {
  inputBuffer: ArrayBuffer;
  fileName: string;
  format: 'gif' | 'webp';
  quality: 'low' | 'medium' | 'high';
  scale: number;
  trimStart: number;
  trimEnd: number;
  maxMemoryMB: number;
}

export interface ConversionProgress {
  phase: 'decoding' | 'encoding' | 'assembling';
  progress: number;
  fps: number;
  etaSeconds: number | null;
  memoryMB: number;
}
