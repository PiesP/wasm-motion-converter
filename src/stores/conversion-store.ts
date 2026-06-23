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

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const [conversionResults, setConversionResults] = createSignal<ConversionResult[]>([]);

// ---------------------------------------------------------------------------
// Media (input file / metadata / preview URL)
// ---------------------------------------------------------------------------

export const [inputFile, setInputFile] = createSignal<File | null>(null);
export const [inputBuffer, setInputBuffer] = createSignal<ArrayBuffer | null>(null);
export const [videoMetadata, setVideoMetadata] = createSignal<VideoMetadata | null>(null);
export const [videoPreviewUrl, setVideoPreviewUrl] = createSignal<string | null>(null);
