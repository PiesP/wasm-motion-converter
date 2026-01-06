/**
 * Debounce Utility Module
 *
 * Provides a debounced function wrapper that delays function invocation until
 * after a specified delay has elapsed since the last call. Useful for performance
 * optimization when handling frequent events (scroll, resize, input).
 */

/**
 * Creates a debounced function that delays invoking the provided function
 * until after the specified delay has elapsed since the last time the debounced
 * function was invoked.
 *
 * Each call to the debounced function resets the delay timer. The original function
 * is only executed after the delay has passed without any new invocations.
 *
 * @template T - The type of the function to debounce
 * @param func - The function to debounce
 * @param wait - The number of milliseconds to delay (e.g., 300, 500, 1000)
 * @returns A debounced version of the function that returns void
 *
 * @example
 * ```ts
 * // Debounce search input (wait 300ms for user to stop typing)
 * const debouncedSearch = debounce((query: string) => {
 *   performSearch(query);
 * }, 300);
 *
 * inputElement.addEventListener('input', (e) => {
 *   debouncedSearch((e.target as HTMLInputElement).value);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Debounce window resize handler
 * const debouncedResize = debounce(() => {
 *   updateLayout();
 * }, 200);
 *
 * window.addEventListener('resize', debouncedResize);
 * ```
 *
 * @note The debounced function discards return values from the original function.
 *       Only use debounce for fire-and-forget operations or side effects.
 * @note To cancel a pending debounced call, store the timeout ID separately
 *       or implement a cancel mechanism if needed.
 */
export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function debounced(...args: Parameters<T>): void {
    // Clear existing timer if function called again before delay elapsed
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    // Schedule function invocation after delay
    timeoutId = setTimeout(() => {
      func(...args);
      // Reset timer reference after execution
      timeoutId = null;
    }, wait);
  };
}
