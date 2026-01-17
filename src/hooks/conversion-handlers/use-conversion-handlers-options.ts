import type { Setter } from 'solid-js';

export interface ConversionHandlersOptions {
  conversionStartTime: () => number;
  setConversionStartTime: Setter<number>;
  setEstimatedSecondsRemaining: Setter<number | null>;
  setMemoryWarning: Setter<boolean>;
}
