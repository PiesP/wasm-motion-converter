// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Conversion Store
 *
 * Unified reactive state for the active conversion session. Consolidates
 * the former `conversion-error-store`, `conversion-progress-store`,
 * `conversion-result-store`, and `conversion-media-store` into a single
 * module to keep related signals colocated and reduce import churn.
 *
 * `conversion-settings-store` remains separate because it owns localStorage
 * persistence, and that concern is orthogonal to transient runtime state.
 */

import type { AppState } from '@t/app-types';
import type { ConversionResult, ErrorContext, VideoMetadata } from '@t/conversion-types';
import { createSignal } from 'solid-js';

// ---------------------------------------------------------------------------
// App-level state
// ---------------------------------------------------------------------------

export const [appState, setAppState] = createSignal<AppState>('idle');
export const [environmentSupported, setEnvironmentSupported] = createSignal<boolean>(true);

/** Update the app state synchronously when it has changed. */
export function transitionToState(newState: AppState): void {
  if (appState() === newState) return;
  setAppState(newState);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
export const [errorContext, setErrorContext] = createSignal<ErrorContext | null>(null);

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export const [conversionProgress, setConversionProgress] = createSignal<number>(0);
export const [conversionStatusMessage, setConversionStatusMessage] = createSignal<string>('');
export const [conversionFps, setConversionFps] = createSignal<number | undefined>(undefined);
export const [conversionElapsedMs, setConversionElapsedMs] = createSignal<number | undefined>(
  undefined
);
export const [outputFrames, setOutputFrames] = createSignal<number | undefined>(undefined);
const [, setCurrentFrame] = createSignal<number | undefined>(undefined);
const [, setTotalFrames] = createSignal<number | undefined>(undefined);

export { setCurrentFrame, setTotalFrames };

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const [conversionResults, setConversionResults] = createSignal<ConversionResult[]>([]);

// ---------------------------------------------------------------------------
// Media (input file / metadata / preview URL)
// ---------------------------------------------------------------------------

export const [inputFile, setInputFile] = createSignal<File | null>(null);

/**
 * Module-level mutable buffer reference for the input file.
 *
 * This is intentionally module-level mutable state (rather than a reactive signal)
 * because:
 * 1. ArrayBuffers can be up to 500 MB; storing in a SolidJS signal would create a
 *    reactive dependency that triggers re-renders on every change.
 * 2. The buffer is only needed during conversion — there is no UI that observes it.
 * 3. Module-level state is safe in this SPA because only one conversion runs at a
 *    time. The getter/setter API (getInputBuffer/setInputBuffer) provides controlled
 *    access without exposing the mutable reference for uncontrolled reassignment.
 */
let inputBufferRef: ArrayBuffer | null = null;
export function getInputBuffer(): ArrayBuffer | null {
  return inputBufferRef;
}
export function setInputBuffer(buffer: ArrayBuffer | null): void {
  inputBufferRef = buffer;
}

export const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);
export const [videoPreviewUrl, setVideoPreviewUrl] = createSignal<string | null>(null);
