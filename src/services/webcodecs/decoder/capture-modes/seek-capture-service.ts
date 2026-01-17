import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

export interface SeekCaptureOptions {
  video: HTMLVideoElement;
  duration: number;
  targetFps: number;
  captureFrame: (index: number, timestamp: number) => Promise<void>;
  shouldCancel?: () => boolean;
  maxFrames?: number;
  codec?: string;
  getSeekTimeoutForCodec: (codec?: string) => number;
  seekTo: (video: HTMLVideoElement, time: number, timeoutMs: number) => Promise<void>;
}

/**
 * Capture frames using manual seeking.
 *
 * Universal fallback method that works in all browsers.
 * Seeks to each frame position and captures after 'seeked' event.
 */
export async function captureWithSeeking(options: SeekCaptureOptions): Promise<void> {
  const {
    video,
    duration,
    targetFps,
    captureFrame,
    shouldCancel,
    maxFrames,
    codec,
    getSeekTimeoutForCodec,
    seekTo,
  } = options;

  const start = Date.now();
  video.pause();

  const seekTimeout = getSeekTimeoutForCodec(codec);

  // Fast extraction for single-frame formats (WebP)
  if (maxFrames === 1) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const epsilon = 0.001;
    const representativeTime = Math.min(duration - epsilon, Math.max(epsilon, duration * 0.25));

    logger.info('conversion', 'Fast single-frame extraction', {
      duration,
      targetTime: representativeTime,
      position: '25%',
    });

    await seekTo(video, representativeTime, seekTimeout);
    await captureFrame(0, representativeTime);
    return;
  }

  let frameInterval = 1 / targetFps;
  let totalFrames =
    maxFrames && maxFrames > 0
      ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
      : Math.max(1, Math.ceil(duration * targetFps));
  const epsilon = 0.001;

  const {
    TIMING_SAMPLE_SIZE,
    SLOW_SEEK_THRESHOLD_MS,
    FPS_DOWNSHIFT_FACTOR,
    MIN_FPS_AFTER_DOWNSHIFT,
  } = FFMPEG_INTERNALS.WEBCODECS.SEEK_PERFORMANCE;

  const seekTimings: number[] = [];
  let adjustedFps = targetFps;

  for (let index = 0; index < totalFrames; index += 1) {
    if (shouldCancel?.()) {
      throw new Error('Conversion cancelled by user');
    }

    const seekStart = Date.now();
    const targetTime = Math.min(duration - epsilon, index * frameInterval);
    await seekTo(video, targetTime, seekTimeout);
    const seekElapsed = Date.now() - seekStart;

    if (index < TIMING_SAMPLE_SIZE) {
      seekTimings.push(seekElapsed);

      if (index === TIMING_SAMPLE_SIZE - 1) {
        const avgSeekTime = seekTimings.reduce((a, b) => a + b) / seekTimings.length;

        if (avgSeekTime > SLOW_SEEK_THRESHOLD_MS) {
          adjustedFps = Math.max(
            MIN_FPS_AFTER_DOWNSHIFT,
            Math.ceil(targetFps * FPS_DOWNSHIFT_FACTOR)
          );
          frameInterval = 1 / adjustedFps;
          const newTotalFrames = Math.ceil(duration * adjustedFps);

          logger.warn('conversion', 'Slow seek detected, reducing FPS', {
            avgSeekTimeMs: avgSeekTime.toFixed(1),
            originalFps: targetFps,
            adjustedFps,
            originalFrames: totalFrames,
            newFrames: newTotalFrames,
          });

          totalFrames = newTotalFrames;
        }
      }
    }

    await captureFrame(index, Math.min(duration - epsilon, index * frameInterval));
  }

  logger.info(
    'conversion',
    `WebCodecs seek-based capture completed: capturedFrames=${totalFrames}, totalFrames=${totalFrames}`,
    {
      capturedFrames: totalFrames,
      totalFrames,
      elapsedMs: Date.now() - start,
    }
  );
}
