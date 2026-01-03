/**
 * Format duration in seconds to human-readable time string
 * @param seconds - Duration in seconds
 * @returns Formatted time string (e.g., "1:23" for MM:SS or "1:02:34" for HH:MM:SS)
 */
export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
