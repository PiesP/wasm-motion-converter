/**
 * Format duration in seconds to human-readable time string
 *
 * @param seconds - Duration in seconds
 * @returns Formatted time string (e.g., "1:23" for MM:SS or "1:02:34" for HH:MM:SS)
 *
 * @example
 * formatDuration(0) // "0:00"
 * formatDuration(83) // "1:23"
 * formatDuration(3754) // "1:02:34"
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
