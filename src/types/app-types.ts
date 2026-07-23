// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Application state
 *
 * - `idle`: Waiting for user to select a video file
 * - `analyzing`: Extracting video metadata via mediabunny
 * - `converting`: Active video conversion in progress
 * - `cancelling`: Cancelling an active operation
 * - `done`: Conversion completed successfully
 * - `error`: An error occurred
 */
export type AppState = 'idle' | 'analyzing' | 'converting' | 'cancelling' | 'done' | 'error';
