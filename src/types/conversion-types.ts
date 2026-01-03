export type ConversionFormat = 'gif' | 'webp';
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
