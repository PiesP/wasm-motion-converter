import type { Setter } from 'solid-js';

/**
 * Options for the conversion handlers hook.
 *
 * Note: This lives in a separate module to keep the main hook file small.
 */
export interface ConversionHandlersOptions {
  /** Get current conversion start time in milliseconds */
  conversionStartTime: () => number;
  /** Set conversion start time in milliseconds */
  setConversionStartTime: Setter<number>;
  /** Set estimated seconds remaining for ETA display */
  setEstimatedSecondsRemaining: Setter<number | null>;
  /** Set memory warning flag */
  setMemoryWarning: Setter<boolean>;
}
