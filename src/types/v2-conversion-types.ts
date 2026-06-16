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

export type ConversionPhase = 'demuxing' | 'decoding' | 'encoding' | 'assembling';

export interface ConversionProgress {
  phase: ConversionPhase;
  progress: number;
  fps: number;
  etaSeconds: number | null;
  memoryMB: number;
  currentFrame?: number;
  totalFrames?: number;
  elapsedMs?: number;
}
