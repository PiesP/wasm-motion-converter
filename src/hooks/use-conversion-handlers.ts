import type { ConversionHandlersOptions } from '@/hooks/conversion-handlers/use-conversion-handlers-options';
import { ConversionRuntimeController } from '@/hooks/conversion-handlers/use-conversion-runtime-controller';
import { handleFileSelected } from '@/hooks/conversion-handlers/use-handle-file-selected';
import {
  handleCancelConversion,
  handleConvert,
  handleDismissError,
  handleReset,
  handleRetry,
} from '@/hooks/conversion-handlers/use-perform-conversion';

export function useConversionHandlers(options: ConversionHandlersOptions): {
  handleFileSelected: (file: File) => Promise<void>;
  handleConvert: () => Promise<void>;
  handleReset: () => void;
  handleCancelConversion: () => void;
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
    handleRetry: () => handleRetry(runtime),
    handleDismissError,
  };
}
