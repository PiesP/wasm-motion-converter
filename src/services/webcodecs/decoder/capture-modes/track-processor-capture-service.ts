import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';

export interface TrackProcessorCaptureOptions {
  video: HTMLVideoElement;
  duration: number;
  targetFps: number;
  captureFrame: (index: number, timestamp: number) => Promise<void>;
  shouldCancel?: () => boolean;
  maxFrames?: number;
}

/**
 * Capture frames using MediaStreamTrackProcessor.
 *
 * Uses experimental MediaStreamTrackProcessor API for hardware-accelerated capture.
 * Requires MediaStream.captureStream() support.
 */
export async function captureWithTrackProcessor(
  options: TrackProcessorCaptureOptions
): Promise<void> {
  const { video, duration, targetFps, captureFrame, shouldCancel, maxFrames } = options;

  if (
    typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof (video as unknown as Record<string, unknown>).captureStream !== 'function'
  ) {
    throw new Error('WebCodecs track processor is not available in this browser.');
  }

  try {
    await video.play();
  } catch (error) {
    logger.warn('conversion', 'Autoplay blocked for track capture', {
      error: getErrorMessage(error),
    });
    throw error;
  }

  const stream = (video as unknown as { captureStream(): MediaStream }).captureStream();
  const [track] = stream.getVideoTracks();
  if (!track) {
    throw new Error('No video track available for WebCodecs capture.');
  }

  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  const frameIntervalUs = 1_000_000 / targetFps;
  const totalFrames =
    maxFrames && maxFrames > 0
      ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
      : Math.max(1, Math.ceil(duration * targetFps));
  const epsilonUs = 1_000;

  // TrackProcessor frame timestamps may start with a non-zero offset.
  // Anchor the sampling schedule to the first observed timestamp.
  let baseTimestampUs: number | null = null;
  let nextFrameTimeUs = 0;
  let frameIndex = 0;
  const startDecodeTime = Date.now();

  const readFrame = async (): Promise<ReadableStreamReadResult<VideoFrame>> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<VideoFrame>>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('WebCodecs track capture stalled.'));
          }, FFMPEG_INTERNALS.WEBCODECS.FRAME_STALL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  try {
    while (frameIndex < totalFrames) {
      if (shouldCancel?.()) {
        throw new Error('Conversion cancelled by user');
      }

      const elapsed = Date.now() - startDecodeTime;
      if (elapsed > FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS) {
        throw new Error(
          `WebCodecs decode exceeded ${FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS}ms timeout at frame ${frameIndex}. ` +
            'Codec incompatibility detected. Falling back to FFmpeg.'
        );
      }

      const { value: frame, done } = await readFrame();
      if (done || !frame) {
        break;
      }

      try {
        const timestampUs =
          typeof frame.timestamp === 'number'
            ? frame.timestamp
            : Math.round(video.currentTime * 1_000_000);

        if (baseTimestampUs === null) {
          baseTimestampUs = timestampUs;
          nextFrameTimeUs = baseTimestampUs;
        }

        const shouldCapture = frameIndex === 0 || timestampUs + epsilonUs >= nextFrameTimeUs;

        if (shouldCapture) {
          const captureTimestampSeconds = Math.max(0, timestampUs / 1_000_000);
          await captureFrame(frameIndex, captureTimestampSeconds);
          frameIndex += 1;
          nextFrameTimeUs = (baseTimestampUs ?? 0) + frameIndex * frameIntervalUs;
        }

        if (timestampUs / 1_000_000 >= duration) {
          break;
        }
      } finally {
        frame.close();
      }
    }
  } finally {
    reader.releaseLock();
    track.stop();
    video.pause();
    logger.info(
      'conversion',
      `WebCodecs track capture completed: capturedFrames=${frameIndex}, totalFrames=${totalFrames}, elapsedMs=${
        Date.now() - startDecodeTime
      }`,
      {
        capturedFrames: frameIndex,
        totalFrames,
        elapsedMs: Date.now() - startDecodeTime,
      }
    );
  }
}
