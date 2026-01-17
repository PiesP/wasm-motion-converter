import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

/**
 * If requestVideoFrameCallback produces no callbacks within this window,
 * abort the realtime capture attempt so callers can fall back quickly.
 */
const FRAME_CALLBACK_FIRST_FRAME_TIMEOUT_MS = 1500;

/**
 * If playback advances but requestVideoFrameCallback under-produces frames
 * relative to the requested sampling rate, abort quickly and allow fallback.
 */
const FRAME_CALLBACK_LAG_CHECK_INTERVAL_MS = 250;
const FRAME_CALLBACK_LAG_MIN_MEDIA_ADVANCE_SECONDS = 0.75;
const FRAME_CALLBACK_LAG_MIN_EXPECTED_FRAMES = 8;
const FRAME_CALLBACK_LAG_MAX_CAPTURED_FRAMES = 1;

export interface FrameCallbackCaptureOptions {
  video: HTMLVideoElement;
  duration: number;
  targetFps: number;
  captureFrame: (index: number, timestamp: number) => Promise<void>;
  shouldCancel?: () => boolean;
  maxFrames?: number;
  codec?: string;
  captureWithSeeking: (
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean,
    maxFrames?: number,
    codec?: string
  ) => Promise<void>;
}

/**
 * Capture frames using requestVideoFrameCallback.
 *
 * Uses Chrome/Edge's requestVideoFrameCallback API for precise frame timing.
 * Falls back to seek-based capture if autoplay is blocked.
 */
export async function captureWithFrameCallback(
  options: FrameCallbackCaptureOptions
): Promise<void> {
  const {
    video,
    duration,
    targetFps,
    captureFrame,
    shouldCancel,
    maxFrames,
    codec,
    captureWithSeeking,
  } = options;

  const start = Date.now();

  try {
    await video.play();
  } catch (error) {
    logger.warn('conversion', 'Autoplay blocked, falling back to seek capture', {
      error: getErrorMessage(error),
    });
    await captureWithSeeking(
      video,
      duration,
      targetFps,
      captureFrame,
      shouldCancel,
      maxFrames,
      codec
    );
    return;
  }

  const frameInterval = 1 / targetFps;
  const totalFrames =
    maxFrames && maxFrames > 0
      ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
      : Math.max(1, Math.ceil(duration * targetFps));
  const epsilon = 0.001;

  // IMPORTANT: Keep sampling schedule stable.
  // We anchor the schedule to t=0 and compute thresholds from the frame index.
  let nextFrameTime = 0;
  let frameIndex = 0;

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
    let lagMonitorTimer: ReturnType<typeof setInterval> | null = null;

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };

    const clearFirstFrameTimer = () => {
      if (firstFrameTimer) {
        clearTimeout(firstFrameTimer);
        firstFrameTimer = null;
      }
    };

    const clearLagMonitor = () => {
      if (lagMonitorTimer) {
        clearInterval(lagMonitorTimer);
        lagMonitorTimer = null;
      }
    };

    const scheduleStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        if (finished) {
          return;
        }
        finished = true;
        clearFirstFrameTimer();
        clearLagMonitor();
        reject(new Error('WebCodecs frame capture stalled.'));
      }, FFMPEG_INTERNALS.WEBCODECS.FRAME_STALL_TIMEOUT_MS);
    };

    const finalize = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearStallTimer();
      clearFirstFrameTimer();
      clearLagMonitor();
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
      resolve();
    };

    const scheduleFirstFrameTimer = () => {
      clearFirstFrameTimer();
      firstFrameTimer = setTimeout(() => {
        if (finished) {
          return;
        }
        if (frameIndex > 0) {
          return;
        }

        logger.warn(
          'conversion',
          'WebCodecs frame-callback produced no frames quickly; aborting to allow fallback',
          {
            timeoutMs: FRAME_CALLBACK_FIRST_FRAME_TIMEOUT_MS,
            durationSeconds: duration,
            targetFps,
            totalFrames,
          }
        );

        try {
          video.pause();
        } catch {
          // Non-fatal.
        }

        finalize();
      }, FRAME_CALLBACK_FIRST_FRAME_TIMEOUT_MS);
    };

    const startLagMonitor = () => {
      clearLagMonitor();
      lagMonitorTimer = setInterval(() => {
        if (finished) {
          return;
        }

        const mediaTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        if (mediaTime < FRAME_CALLBACK_LAG_MIN_MEDIA_ADVANCE_SECONDS) {
          return;
        }

        const expectedFrames = Math.floor(mediaTime * targetFps);
        const isLaggingBadly =
          expectedFrames >= FRAME_CALLBACK_LAG_MIN_EXPECTED_FRAMES &&
          frameIndex <= FRAME_CALLBACK_LAG_MAX_CAPTURED_FRAMES;

        if (!isLaggingBadly) {
          return;
        }

        logger.warn(
          'conversion',
          'WebCodecs frame-callback is lagging far behind playback; aborting to allow fallback',
          {
            mediaTimeSeconds: mediaTime,
            targetFps,
            expectedFrames,
            capturedFrames: frameIndex,
            intervalMs: FRAME_CALLBACK_LAG_CHECK_INTERVAL_MS,
          }
        );

        try {
          video.pause();
        } catch {
          // Non-fatal.
        }

        finalize();
      }, FRAME_CALLBACK_LAG_CHECK_INTERVAL_MS);
    };

    const handleEnded = () => {
      finalize();
    };

    const handleError = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearStallTimer();
      clearFirstFrameTimer();
      clearLagMonitor();
      reject(new Error('WebCodecs video decode error.'));
    };

    video.addEventListener('ended', handleEnded, { once: true });
    video.addEventListener('error', handleError, { once: true });
    scheduleStallTimer();
    scheduleFirstFrameTimer();
    startLagMonitor();

    const handleFrame = async (
      _now: number,
      metadata: VideoFrameCallbackMetadata
    ): Promise<void> => {
      try {
        if (finished) {
          return;
        }
        if (shouldCancel?.()) {
          finished = true;
          clearFirstFrameTimer();
          clearLagMonitor();
          reject(new Error('Conversion cancelled by user'));
          return;
        }

        if (frameIndex === 0) {
          clearFirstFrameTimer();
        }

        const mediaTime = metadata.mediaTime ?? video.currentTime;
        const shouldCapture = frameIndex === 0 || mediaTime + epsilon >= nextFrameTime;

        if (shouldCapture) {
          const captureTimestamp = Math.max(0, mediaTime);
          await captureFrame(frameIndex, captureTimestamp);
          frameIndex += 1;
          nextFrameTime = frameIndex * frameInterval;
          scheduleStallTimer();
        }

        if (frameIndex >= totalFrames || mediaTime + epsilon >= duration || video.ended) {
          finalize();
          return;
        }

        video.requestVideoFrameCallback(handleFrame);
      } catch (error) {
        if (finished) {
          return;
        }
        finished = true;
        clearStallTimer();
        clearFirstFrameTimer();
        clearLagMonitor();
        reject(error);
      }
    };

    video.requestVideoFrameCallback(handleFrame);
  });

  logger.info(
    'conversion',
    `WebCodecs frame-callback capture completed: capturedFrames=${frameIndex}, totalFrames=${totalFrames}`,
    {
      capturedFrames: frameIndex,
      totalFrames,
      elapsedMs: Date.now() - start,
    }
  );
}
