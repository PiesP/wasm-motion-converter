// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import type { ProgressPhase } from '@t/conversion-types';
import type { TFunction } from '@t/i18n-types';
import { onCleanup, type Setter } from 'solid-js';
import { ConversionRuntimeController } from './conversion-handlers/use-conversion-runtime-controller';
import { handleFileSelected } from './conversion-handlers/use-handle-file-selected';
import {
  handleCancelAnalysis,
  handleCancelConversion,
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
  setConversionPhase?: Setter<ProgressPhase>;
  t: TFunction;
}

export function useConversionHandlers(options: ConversionHandlersOptions): {
  handleFileSelected: (file: File) => Promise<void>;
  handleConvert: () => Promise<void>;
  handleReset: () => void;
  handleCancelConversion: () => void;
  handleCancelAnalysis: () => void;
  handleRetry: () => void;
  handleDismissError: () => void;
} {
  const runtime = new ConversionRuntimeController({
    setConversionStartTime: options.setConversionStartTime,
    setEstimatedSecondsRemaining: options.setEstimatedSecondsRemaining,
    setMemoryWarning: options.setMemoryWarning,
    setConversionPhase: options.setConversionPhase,
  });

  onCleanup(() => {
    runtime.resetTimingState();
  });

  return {
    handleFileSelected: (file: File) => handleFileSelected(file, runtime, options.t),
    handleConvert: () => handleConvert(runtime, options.t),
    handleReset: () => handleReset(runtime),
    handleCancelConversion: () => handleCancelConversion(runtime),
    handleCancelAnalysis,
    handleRetry: () => handleRetry(runtime, options.t),
    handleDismissError,
  };
}
