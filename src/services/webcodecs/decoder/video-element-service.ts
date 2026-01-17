/**
 * Video element helpers for WebCodecs-based capture.
 */

import { waitForEvent } from '@services/webcodecs/decoder/wait-for-event-service';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

/**
 * Normalize video duration.
 * Ensures duration is a finite number, returns 0 for invalid values.
 */
export const normalizeDuration = (duration: number): number =>
  Number.isFinite(duration) ? duration : 0;

/**
 * Keep a video element attached to the DOM to reduce throttling.
 */
export const attachVideoForDecode = (video: HTMLVideoElement): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const body = document.body;
  if (!body) {
    return;
  }

  if (video.parentElement) {
    return;
  }

  try {
    video.style.position = 'fixed';
    // Keep the element inside the viewport so browsers treat it as "rendered".
    video.style.right = '0';
    video.style.bottom = '0';
    video.style.width = '2px';
    video.style.height = '2px';
    // Avoid fully transparent (0) to reduce the chance of "not painted" optimizations.
    video.style.opacity = '0.001';
    video.style.pointerEvents = 'none';
    video.style.zIndex = '0';
    video.style.background = 'transparent';
    video.style.contain = 'strict';
    video.style.transform = 'translateZ(0)';
    body.appendChild(video);
  } catch (error) {
    logger.debug('conversion', 'Failed to attach video element for decode', {
      error: getErrorMessage(error),
    });
  }
};

/**
 * Calculate codec-aware seek timeout.
 */
export const getSeekTimeoutForCodec = (codec?: string): number => {
  if (!codec) {
    return 1500;
  }

  const normalizedCodec = codec.toLowerCase();
  const isAv1 = normalizedCodec.includes('av1') || normalizedCodec.includes('av01');
  const isVp9 = normalizedCodec.includes('vp9') || normalizedCodec.includes('vp09');
  const isHevc = normalizedCodec.includes('hevc') || normalizedCodec.includes('hvc1');

  if (isAv1 || isHevc) {
    return 2000;
  }
  if (isVp9) {
    return 1800;
  }

  return 1500;
};

/**
 * Seek video to a specific time.
 */
export const seekTo = async (
  video: HTMLVideoElement,
  time: number,
  timeoutMs: number = FFMPEG_INTERNALS.WEBCODECS.SEEK_TIMEOUT_MS
): Promise<void> => {
  if (Number.isNaN(time)) {
    throw new Error('Invalid seek time for video decode.');
  }

  const clampedTime = Math.max(0, time);
  if (Math.abs(video.currentTime - clampedTime) < 0.0001) {
    return;
  }

  const maybeFastSeek = video as HTMLVideoElement & {
    fastSeek?: (time: number) => void;
  };

  if (typeof maybeFastSeek.fastSeek === 'function') {
    maybeFastSeek.fastSeek(clampedTime);
  } else {
    video.currentTime = clampedTime;
  }

  await waitForEvent(video, 'seeked', timeoutMs);
};

/**
 * Clean up a video element and revoke its object URL.
 */
export const cleanupVideo = (args: {
  video: HTMLVideoElement;
  url: string;
  activeUrls: Set<string>;
}): void => {
  const { video, url, activeUrls } = args;
  const cleanupStart = Date.now();

  try {
    logger.debug('conversion', 'WebCodecs: Starting video cleanup');

    try {
      video.pause();
      logger.debug('conversion', 'WebCodecs: Video paused');
    } catch (error) {
      logger.debug('conversion', 'WebCodecs: Failed to pause video', {
        error: getErrorMessage(error),
      });
    }

    try {
      video.removeAttribute('src');
      video.srcObject = null;
      logger.debug('conversion', 'WebCodecs: Src attribute and srcObject cleared');
    } catch (error) {
      logger.debug('conversion', 'WebCodecs: Failed to remove src attribute/srcObject', {
        error: getErrorMessage(error),
      });
    }

    try {
      video.load();
      logger.debug('conversion', 'WebCodecs: Load called to reset media');
    } catch (error) {
      logger.debug('conversion', 'WebCodecs: Failed to call load', {
        error: getErrorMessage(error),
      });
    }

    try {
      video.currentTime = 0;
      video.autoplay = false;
      video.controls = false;
      logger.debug('conversion', 'WebCodecs: Media element properties reset');
    } catch (error) {
      logger.debug('conversion', 'WebCodecs: Failed to reset media element properties', {
        error: getErrorMessage(error),
      });
    }

    if (video.parentElement) {
      try {
        video.remove();
        logger.debug('conversion', 'WebCodecs: Video element removed from DOM');
      } catch (error) {
        logger.debug('conversion', 'WebCodecs: Failed to remove video from DOM', {
          error: getErrorMessage(error),
        });
      }
    }
  } catch (error) {
    logger.debug('conversion', 'WebCodecs: Video element cleanup failed', {
      error: getErrorMessage(error),
    });
  }

  try {
    if (activeUrls.has(url)) {
      URL.revokeObjectURL(url);
      activeUrls.delete(url);
      logger.debug('conversion', 'WebCodecs: Object URL revoked');
    }
  } catch (error) {
    logger.debug('conversion', 'WebCodecs: Failed to revoke object URL', {
      error: getErrorMessage(error),
    });
  }

  const cleanupTime = Date.now() - cleanupStart;
  logger.debug('conversion', 'WebCodecs: Video cleanup complete', {
    elapsedMs: cleanupTime,
  });
};
