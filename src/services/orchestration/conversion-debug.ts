/**
 * Conversion Debug State (Dev Only)
 *
 * Lightweight in-memory debug state for diagnosing conversion path auto-selection.
 *
 * Notes:
 * - This module intentionally avoids any persistence.
 * - Consumers should only expose these getters in dev mode.
 */

import type { ConversionFormat } from '@t/conversion-types';

import type { ConversionPath } from './types';

export type ConversionDebugOutcome = 'success' | 'error' | 'cancelled';

export interface ConversionAutoSelectionDebug {
  timestamp: number;
  format: ConversionFormat;
  codec?: string;
  container?: string;

  plannedPath: ConversionPath;
  plannedReason: string;
  strategyConfidence?: 'high' | 'medium' | 'low';

  // Demuxer is planned/available information (not a guarantee of actual runtime usage yet).
  demuxerAvailable?: boolean;
  useDemuxerPlanned?: boolean;

  // Capability signals used by the planner.
  hardwareAccelerated?: boolean;
  sharedArrayBuffer?: boolean;
  crossOriginIsolated?: boolean;
  workerSupport?: boolean;

  // Runtime execution details (best-effort).
  executedPath?: ConversionPath;
  encoderBackend?: string;
  captureModeUsed?: string | null;

  outcome?: ConversionDebugOutcome;
  errorMessage?: string;
}

export interface ConversionPhaseTimingsDebug {
  timestamp: number;
  initializationMs: number;
  analysisMs: number;
  conversionMs: number;
  totalMs: number;
  outcome?: ConversionDebugOutcome;
}

let lastDecision: ConversionAutoSelectionDebug | null = null;
let lastPhaseTimings: ConversionPhaseTimingsDebug | null = null;

export function setConversionAutoSelectionDebug(next: ConversionAutoSelectionDebug): void {
  lastDecision = next;
}

export function updateConversionAutoSelectionDebug(
  patch: Partial<ConversionAutoSelectionDebug>
): void {
  lastDecision = lastDecision ? { ...lastDecision, ...patch } : null;
}

export function getConversionAutoSelectionDebug(): ConversionAutoSelectionDebug | null {
  return lastDecision;
}

export function setConversionPhaseTimingsDebug(next: ConversionPhaseTimingsDebug): void {
  lastPhaseTimings = next;
}

export function getConversionPhaseTimingsDebug(): ConversionPhaseTimingsDebug | null {
  return lastPhaseTimings;
}
