// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { ffmpegService } from '@services/cpu-path/ffmpeg-pipeline-service';

/**
 * Hook for exporting application and FFmpeg logs.
 *
 * Provides a stable reference to FFmpeg's log ring buffer for use by
 * the ExportLogsButton component. Keeps the UI layer free of direct
 * service-layer dependencies.
 */
export function useExportLogs() {
  return { getFfmpegLogs: () => ffmpegService.getRecentFFmpegLogs() };
}
