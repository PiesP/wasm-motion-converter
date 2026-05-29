// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import type { Setter } from 'solid-js';
import { ConversionRuntimeController } from './conversion-handlers/use-conversion-runtime-controller';
import { handleFileSelected } from './conversion-handlers/use-handle-file-selected';
import {
  handleCancelAnalysis,
  handleCancelConversion,
  handleCancelFFmpegLoad,
  handleConvert,
  handleDismissError,
  handleReset,
  handleRetry,
} from './conversion-handlers/use-perform-conversion';

interface ConversionHandlersOptions {
  conversionStartTime: () => number;
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
}

export function useConversionHandlers(options: ConversionHandlersOptions): {
  handleFileSelected: (file: File) => Promise<void>;
  handleConvert: () => Promise<void>;
  handleReset: () => void;
  handleCancelConversion: () => void;
  handleCancelFFmpegLoad: () => void;
  handleCancelAnalysis: () => void;
  handleRetry: () => void;
  handleDismissError: () => void;
} {
  const runtime = new ConversionRuntimeController({
    setConversionStartTime: options.setConversionStartTime,
    setEstimatedSecondsRemaining: options.setEstimatedSecondsRemaining,
    setMemoryWarning: options.setMemoryWarning,
  });

  return {
    handleFileSelected: (file: File) => handleFileSelected(file, runtime),
    handleConvert: () => handleConvert(runtime),
    handleReset: () => handleReset(runtime),
    handleCancelConversion: () => handleCancelConversion(runtime),
    handleCancelFFmpegLoad,
    handleCancelAnalysis,
    handleRetry: () => handleRetry(runtime),
    handleDismissError,
  };
}
