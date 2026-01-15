// Internal imports
import { TIMEOUT_FFMPEG_WORKER_CHECK } from '@utils/constants';
import { logger } from '@utils/logger';
import { withTimeout } from '@utils/with-timeout';

/**
 * Legacy timeout constant for backward compatibility with worker check timeout.
 *
 * Kept here to preserve the exact error message used by the original implementation.
 */
const WORKER_CHECK_TIMEOUT_SECONDS = TIMEOUT_FFMPEG_WORKER_CHECK / 1000;

/**
 * Worker isolation status for FFmpeg multi-threading support.
 */
interface WorkerIsolationStatus {
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}

/**
 * Verify that Web Workers have proper isolation for SharedArrayBuffer.
 * FFmpeg multi-threading requires cross-origin isolation (COOP/COEP headers).
 * Tests worker creation and SharedArrayBuffer availability.
 *
 * @throws Error if Web Workers are unavailable, worker creation fails, or isolation is insufficient
 */
export async function verifyWorkerIsolation(): Promise<void> {
  if (typeof Worker === 'undefined') {
    throw new Error('Web Workers are not available in this browser.');
  }

  const script = `
    self.postMessage({
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      crossOriginIsolated: self.crossOriginIsolated === true,
    });
  `;

  const blobUrl = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  let worker: Worker | null = null;

  try {
    worker = new Worker(blobUrl, { type: 'module' });
    const status = await withTimeout(
      new Promise<WorkerIsolationStatus>((resolve, reject) => {
        if (!worker) {
          reject(new Error('Failed to create FFmpeg worker.'));
          return;
        }
        worker.onmessage = (event) => resolve(event.data as WorkerIsolationStatus);
        worker.onerror = () =>
          reject(
            new Error(
              'Failed to start FFmpeg worker. Browser extensions or security settings may be blocking blob workers.'
            )
          );
      }),
      TIMEOUT_FFMPEG_WORKER_CHECK,
      `FFmpeg worker check timed out after ${WORKER_CHECK_TIMEOUT_SECONDS} seconds.`
    );

    logger.debug('ffmpeg', 'FFmpeg worker isolation verified', {
      sharedArrayBuffer: status.sharedArrayBuffer,
      crossOriginIsolated: status.crossOriginIsolated,
    });

    if (!status.sharedArrayBuffer || !status.crossOriginIsolated) {
      throw new Error(
        'FFmpeg worker does not support SharedArrayBuffer. Cross-origin isolation is required for FFmpeg to run.'
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.name === 'SecurityError' ||
        error.message.includes('Failed to construct') ||
        error.message.includes('Worker')
      ) {
        throw new Error(
          'FFmpeg worker could not be created. Browser extensions or security settings may be blocking module/blob workers. Try disabling blockers or using an InPrivate window.'
        );
      }
    }
    throw error;
  } finally {
    if (worker) {
      worker.terminate();
    }
    URL.revokeObjectURL(blobUrl);
  }
}
