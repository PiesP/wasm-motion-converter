import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

import type { WebCodecsCaptureMode } from '@services/webcodecs/decoder/types';

type PlaybackCaptureMode = Extract<WebCodecsCaptureMode, 'track' | 'frame-callback' | 'seek'>;

type RequestedPlaybackCaptureMode = Extract<
  WebCodecsCaptureMode,
  'auto' | 'track' | 'frame-callback' | 'seek'
>;

export async function runPlaybackCaptureMode(params: {
  requestedCaptureMode: RequestedPlaybackCaptureMode;
  supportsTrackProcessor: boolean;
  supportsFrameCallback: boolean;
  setEffectiveCaptureMode: (mode: PlaybackCaptureMode) => void;
  runMode: (mode: PlaybackCaptureMode, withCodecHint: boolean) => Promise<void>;
}): Promise<PlaybackCaptureMode> {
  const {
    requestedCaptureMode,
    supportsTrackProcessor,
    supportsFrameCallback,
    setEffectiveCaptureMode,
    runMode,
  } = params;

  if (requestedCaptureMode === 'track') {
    if (!supportsTrackProcessor) {
      throw new Error('WebCodecs track processor is not supported in this browser.');
    }

    setEffectiveCaptureMode('track');
    await runMode('track', false);
    return 'track';
  }

  if (requestedCaptureMode === 'frame-callback') {
    if (!supportsFrameCallback) {
      throw new Error('requestVideoFrameCallback is not supported in this browser.');
    }

    setEffectiveCaptureMode('frame-callback');
    await runMode('frame-callback', true);
    return 'frame-callback';
  }

  if (requestedCaptureMode === 'seek') {
    setEffectiveCaptureMode('seek');
    await runMode('seek', true);
    return 'seek';
  }

  // requestedCaptureMode === 'auto'
  if (supportsTrackProcessor) {
    try {
      setEffectiveCaptureMode('track');
      await runMode('track', false);
      return 'track';
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      const errorStack = error instanceof Error ? error.stack : '';

      logger.warn('conversion', 'WebCodecs track capture failed, falling back', {
        error: errorMsg,
        supportsFrameCallback,
        stack: errorStack,
      });

      if (supportsFrameCallback) {
        logger.info('conversion', 'WebCodecs decoder: Attempting frame-callback fallback mode', {});

        setEffectiveCaptureMode('frame-callback');
        await runMode('frame-callback', false);
        return 'frame-callback';
      }

      logger.info(
        'conversion',
        'WebCodecs decoder: frame-callback not supported, using seek fallback',
        {}
      );

      setEffectiveCaptureMode('seek');
      await runMode('seek', false);
      return 'seek';
    }
  }

  if (supportsFrameCallback) {
    setEffectiveCaptureMode('frame-callback');
    await runMode('frame-callback', true);
    return 'frame-callback';
  }

  setEffectiveCaptureMode('seek');
  await runMode('seek', true);
  return 'seek';
}
