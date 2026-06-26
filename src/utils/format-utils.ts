// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * ID generation utility
 *
 * Generates a collision-resistant UUID using `crypto.randomUUID()`.
 */
export function createId(): string {
  return crypto.randomUUID();
}

/**
 * Format duration in seconds to human-readable time string
 *
 * @param seconds - Duration in seconds
 * @returns Formatted time string (e.g., "1:23" for MM:SS or "1:02:34" for HH:MM:SS)
 */
export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const pad = (num: number): string => num.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${pad(mins)}:${pad(secs)}`;
  }

  return `${mins}:${pad(secs)}`;
}

/**
 * Format bytes to human-readable string
 *
 * Converts a byte count into a human-friendly format with appropriate unit
 * (B, KB, MB, GB). Uses binary units (1 KB = 1024 bytes).
 *
 * @param bytes - Number of bytes to format (must be non-negative)
 * @returns Formatted file size string with appropriate unit
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}
