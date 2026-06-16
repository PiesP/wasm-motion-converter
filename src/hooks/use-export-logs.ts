// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { logger } from '@utils/logger';

/**
 * Hook for exporting application logs.
 *
 * Provides access to the application log buffer for use by
 * the ExportLogsButton component.
 */
export function useExportLogs() {
  return { getLogs: () => logger.getRecentLogs() };
}
