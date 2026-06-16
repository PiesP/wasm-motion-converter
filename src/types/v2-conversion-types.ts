export interface ConversionRequest {
  inputBuffer: ArrayBuffer;
  fileName: string;
  format: 'gif' | 'webp';
  quality: 'low' | 'medium' | 'high';
  scale: number;       // 0.1 ~ 1.0
  trimStart: number;   // seconds
  trimEnd: number;     // seconds
  maxMemoryMB: number; // 메모리 상한
}

export interface ConversionProgress {
  phase: 'decoding' | 'encoding' | 'assembling';
  progress: number;  // 0-100
  fps: number;
  etaSeconds: number | null;
  memoryMB: number;
}

export type ConversionWorkerMessage =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'convert'; request: ConversionRequest }
  | { type: 'cancel' }
  | { type: 'progress'; progress: ConversionProgress }
  | { type: 'complete'; output: ArrayBuffer; format: 'gif' | 'webp' }
  | { type: 'error'; message: string; code: string }
  | { type: 'warning'; message: string };
