export type ConversionFormat = 'gif' | 'webp' | 'avif';
export type ConversionQuality = 'low' | 'medium' | 'high';
export type ConversionScale = 0.5 | 0.75 | 1.0;

export interface ConversionSettings {
  format: ConversionFormat;
  quality: ConversionQuality;
  scale: ConversionScale;
}

export interface ConversionOptions {
  quality: ConversionQuality;
  scale: ConversionScale;
}

export interface ConversionResult {
  id: string;
  outputBlob: Blob;
  originalName: string;
  originalSize: number;
  createdAt: number;
  settings: ConversionSettings;
  wasTranscoded?: boolean;
  originalCodec?: string;
}

export type ConversionErrorType = 'timeout' | 'memory' | 'format' | 'codec' | 'general';

export interface ErrorContext {
  type: ConversionErrorType;
  originalError: string;
  timestamp: number;
  suggestion?: string;
  conversionSettings?: ConversionSettings;
  ffmpegLogs?: string[];
  phase?: string;
}

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  codec: string;
  framerate: number;
  bitrate: number;
}

export type PerformanceWarningType = 'fileSize' | 'resolution' | 'duration' | 'codec';
export type PerformanceWarningSeverity = 'warning' | 'error';

export interface PerformanceWarning {
  type: PerformanceWarningType;
  severity: PerformanceWarningSeverity;
  message: string;
  recommendation: string;
}
