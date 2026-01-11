import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';

import { waitForEvent } from './wait-for-event';

/**
 * Calculate codec-aware seek timeout.
 *
 * AV1 and other complex codecs require more time for seeking due to keyframe complexity.
 */
export const getSeekTimeoutForCodec = (codec?: string): number => {
  if (!codec) {
    return 1500;
  }

  const normalizedCodec = codec.toLowerCase();
  const isAv1 = normalizedCodec.includes('av1') || normalizedCodec.includes('av01');
  const isVP9 = normalizedCodec.includes('vp9') || normalizedCodec.includes('vp09');
  const isHEVC = normalizedCodec.includes('hevc') || normalizedCodec.includes('hvc1');

  if (isAv1 || isHEVC) {
    return 2000;
  }
  if (isVP9) {
    return 1800;
  }

  return 1500;
};

/**
 * Seek video to a specific time.
 *
 * Sets video.currentTime (or fastSeek when available) and waits for 'seeked'.
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

  // Prefer fastSeek() when available.
  const maybeFastSeek = video as HTMLVideoElement & { fastSeek?: (time: number) => void };
  if (typeof maybeFastSeek.fastSeek === 'function') {
    maybeFastSeek.fastSeek(clampedTime);
  } else {
    video.currentTime = clampedTime;
  }

  await waitForEvent(video, 'seeked', timeoutMs);
};
