// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Application state
 *
 * - `idle`: Waiting for user to select a video file
 * - `loading-ffmpeg`: Loading FFmpeg WASM module
 * - `analyzing`: Extracting video metadata via mediabunny
 * - `converting`: Active video conversion in progress
 * - `done`: Conversion completed successfully
 * - `error`: An error occurred
 */
export type AppState =
  | 'idle'
  | 'loading-ffmpeg'
  | 'analyzing'
  | 'converting'
  | 'cancelling'
  | 'done'
  | 'error';
