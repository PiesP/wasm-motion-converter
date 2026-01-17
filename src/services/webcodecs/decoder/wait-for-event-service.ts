/**
 * Wait for an event with timeout.
 */
export const waitForEvent = (
  target: EventTarget,
  eventName: string,
  timeoutMs: number
): Promise<Event> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const onEvent = (event: Event) => {
      cleanup();
      resolve(event);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
    };

    target.addEventListener(eventName, onEvent, { once: true });
  });
