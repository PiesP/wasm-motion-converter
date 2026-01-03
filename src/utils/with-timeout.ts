/**
 * Wraps a promise with a timeout
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param errorMessage Custom error message for timeout
 * @param onTimeout Optional callback to execute before rejecting on timeout
 * @returns Promise that rejects if timeout is reached
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
  onTimeout?: () => void
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (onTimeout) {
        onTimeout();
      }
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
