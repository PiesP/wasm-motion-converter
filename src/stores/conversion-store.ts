import { createSignal } from 'solid-js';
import type {
  ConversionSettings,
  PerformanceWarning,
  VideoMetadata,
} from '../types/conversion-types';

export interface ErrorContext {
  type: 'timeout' | 'memory' | 'format' | 'codec' | 'general';
  originalError: string;
  timestamp: number;
  suggestion?: string;
}

export const [inputFile, setInputFile] = createSignal<File | null>(null);
export const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);
export const [conversionSettings, setConversionSettings] = createSignal<ConversionSettings>({
  format: 'gif',
  quality: 'medium',
  scale: 1.0,
});
export const [performanceWarnings, setPerformanceWarnings] = createSignal<PerformanceWarning[]>([]);
export const [conversionProgress, setConversionProgress] = createSignal(0);
export const [conversionStatusMessage, setConversionStatusMessage] = createSignal<string>('');
export const [outputBlob, setOutputBlob] = createSignal<Blob | null>(null);
export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [errorContext, setErrorContext] = createSignal<ErrorContext | null>(null);
