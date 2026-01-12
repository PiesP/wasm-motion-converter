/**
 * App Store
 *
 * Global application state management using SolidJS signals.
 * Tracks high-level application state, FFmpeg loading progress, and environment support.
 */

// External dependencies
import { createSignal } from 'solid-js';

// Type imports
import type { AppState } from '@t/app-types';

/**
 * Current application state
 *
 * Tracks the global workflow state:
 * - 'idle': Waiting for file input
 * - 'loading-ffmpeg': Initializing FFmpeg (first-time ~30MB download)
 * - 'analyzing': Analyzing video metadata
 * - 'converting': Encoding video
 * - 'done': Conversion completed successfully
 * - 'error': Error occurred
 */
export const [appState, setAppState] = createSignal<AppState>('idle');

/**
 * FFmpeg loading progress (0-100)
 *
 * Progress percentage for FFmpeg initialization.
 * Only relevant during 'loading-ffmpeg' state.
 */
export const [loadingProgress, setLoadingProgress] = createSignal<number>(0);

/**
 * FFmpeg loading status message
 *
 * Human-readable status message during FFmpeg initialization.
 * Examples: "Downloading FFmpeg core...", "Initializing worker..."
 */
export const [loadingStatusMessage, setLoadingStatusMessage] = createSignal<string>('');

/**
 * Environment support status
 *
 * Indicates whether the browser environment meets requirements:
 * - SharedArrayBuffer support (for FFmpeg multithreading)
 * - crossOriginIsolated (COOP/COEP headers)
 * - Web Workers support
 *
 * Set to false if critical features are missing.
 */
export const [environmentSupported, setEnvironmentSupported] = createSignal<boolean>(true);
