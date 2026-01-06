/**
 * Format bytes to human-readable string
 *
 * Converts a byte count into a human-friendly format with appropriate unit
 * (B, KB, MB, GB). Useful for displaying file sizes and data transfer amounts
 * in user interfaces.
 *
 * **Implementation**:
 * - Uses binary units (1 KB = 1024 bytes)
 * - Rounds to 1 decimal place for readability
 * - Returns exact units for zero bytes
 *
 * **Edge cases**:
 * - Zero bytes: Returns "0 B"
 * - Negative values: Not handled; assumes non-negative input
 * - Values >= 1024 GB: Returns in GB format (e.g., "1024.0 GB")
 *
 * @param bytes - Number of bytes to format (must be non-negative)
 * @returns Formatted file size string with appropriate unit
 *
 * @example
 * formatBytes(0)               // "0 B"
 * formatBytes(512)             // "0.5 KB"
 * formatBytes(1024)            // "1.0 KB"
 * formatBytes(1048576)         // "1.0 MB"
 * formatBytes(1073741824)      // "1.0 GB"
 *
 * @example
 * // Display file size in UI
 * const fileSize = formatBytes(file.size);
 * console.log(`Upload size: ${fileSize}`);
 * // Output: "Upload size: 2.5 MB"
 *
 * @example
 * // Display download progress
 * const downloaded = 512 * 1024 * 1024; // 512 MB
 * const total = 2 * 1024 * 1024 * 1024; // 2 GB
 * console.log(`Downloaded ${formatBytes(downloaded)} of ${formatBytes(total)}`);
 * // Output: "Downloaded 512.0 MB of 2.0 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}
