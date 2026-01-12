/**
 * Seek-based Capture Adapter
 *
 * Universal fallback method that works in all browsers.
 * Seeks to each frame position and captures after 'seeked' event.
 * For single-frame extraction, seeks to 25% duration for better representation.
 *
 * Features:
 * - Codec-aware seek timeouts (AV1/HEVC need longer timeouts)
 * - Dynamic FPS downshift on slow seeks
 * - Fast single-frame extraction
 * - fastSeek() optimization when available
 */

import { FFMPEG_INTERNALS } from "@utils/ffmpeg-constants";
import { logger } from "@utils/logger";

import type {
  CaptureAdapter,
  FrameCaptureCallback,
} from "@services/gpu-path/types";
import { waitForEvent } from "@services/webcodecs/decoder/wait-for-event";

/**
 * Seek-based capture adapter
 */
export class SeekCaptureAdapter implements CaptureAdapter {
  /**
   * Calculate codec-aware seek timeout
   *
   * AV1 and other complex codecs require more time for seeking due to keyframe complexity.
   *
   * @param codec - Video codec string (e.g., 'av01', 'vp9', 'h264')
   * @returns Timeout in milliseconds
   */
  private getSeekTimeoutForCodec(codec?: string): number {
    if (!codec) {
      return 1500; // Default timeout for unknown codecs
    }

    const normalizedCodec = codec.toLowerCase();
    const isAv1 =
      normalizedCodec.includes("av1") || normalizedCodec.includes("av01");
    const isVp9 =
      normalizedCodec.includes("vp9") || normalizedCodec.includes("vp09");
    const isHevc =
      normalizedCodec.includes("hevc") || normalizedCodec.includes("hvc1");

    // Complex codecs may need more time for seeking
    if (isAv1 || isHevc) {
      return 2000; // 2s for AV1/HEVC
    }
    if (isVp9) {
      return 1800; // 1.8s for VP9
    }

    // Simple codecs (H.264, VP8, etc.) seek quickly
    return 1500; // 1.5s for H.264 and other simple codecs
  }

  /**
   * Seek video to specific time
   *
   * @param video - Video element to seek
   * @param time - Target time in seconds
   * @param timeoutMs - Seek timeout in milliseconds
   */
  private async seekTo(
    video: HTMLVideoElement,
    time: number,
    timeoutMs: number = FFMPEG_INTERNALS.WEBCODECS.SEEK_TIMEOUT_MS
  ): Promise<void> {
    if (Number.isNaN(time)) {
      throw new Error("Invalid seek time for video decode.");
    }

    const clampedTime = Math.max(0, time);
    if (Math.abs(video.currentTime - clampedTime) < 0.0001) {
      return;
    }

    // Prefer fastSeek() when available (can be faster than setting currentTime)
    const maybeFastSeek = video as HTMLVideoElement & {
      fastSeek?: (time: number) => void;
    };
    if (typeof maybeFastSeek.fastSeek === "function") {
      maybeFastSeek.fastSeek(clampedTime);
    } else {
      video.currentTime = clampedTime;
    }
    await waitForEvent(video, "seeked", timeoutMs);
  }

  /**
   * Capture frames using manual seeking
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   * @param codec - Optional codec string for timeout optimization
   */
  async capture(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: FrameCaptureCallback,
    shouldCancel?: () => boolean,
    maxFrames?: number,
    codec?: string
  ): Promise<void> {
    const start = Date.now();
    video.pause();

    // Calculate codec-aware seek timeout
    const seekTimeout = this.getSeekTimeoutForCodec(codec);

    // Fast extraction for single-frame formats (WebP)
    // Seek to a representative frame (25% into video or middle) instead of first frame
    if (maxFrames === 1) {
      if (shouldCancel?.()) {
        throw new Error("Conversion cancelled by user");
      }

      // Choose representative frame: 25% duration mark, clamped to valid range
      // This provides better representation than first frame (often black/fade-in)
      const epsilon = 0.001;
      const representativeTime = Math.min(
        duration - epsilon,
        Math.max(epsilon, duration * 0.25)
      );

      logger.info("conversion", "Fast single-frame extraction", {
        duration,
        targetTime: representativeTime,
        position: "25%",
      });

      await this.seekTo(video, representativeTime, seekTimeout);
      await captureFrame(0, representativeTime);
      return;
    }

    // Standard multi-frame extraction
    let frameInterval = 1 / targetFps;
    let totalFrames =
      maxFrames && maxFrames > 0
        ? Math.max(1, Math.min(maxFrames, Math.ceil(duration * targetFps)))
        : Math.max(1, Math.ceil(duration * targetFps));
    const epsilon = 0.001;

    // Dynamic FPS downshift: measure seek performance and adjust if too slow
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
        throw new Error("Conversion cancelled by user");
      }

      // Measure seek performance during warmup phase
      const seekStart = Date.now();
      const targetTime = Math.min(duration - epsilon, index * frameInterval);
      await this.seekTo(video, targetTime, seekTimeout);
      const seekElapsed = Date.now() - seekStart;

      // Collect timing data during warmup phase
      if (index < TIMING_SAMPLE_SIZE) {
        seekTimings.push(seekElapsed);

        // After warmup, check if FPS downshift is needed
        if (index === TIMING_SAMPLE_SIZE - 1) {
          const avgSeekTime =
            seekTimings.reduce((a, b) => a + b) / seekTimings.length;

          if (avgSeekTime > SLOW_SEEK_THRESHOLD_MS) {
            // Slow seeks detected, reduce FPS
            adjustedFps = Math.max(
              MIN_FPS_AFTER_DOWNSHIFT,
              Math.ceil(targetFps * FPS_DOWNSHIFT_FACTOR)
            );
            frameInterval = 1 / adjustedFps;
            const newTotalFrames = Math.ceil(duration * adjustedFps);

            logger.warn("conversion", "Slow seek detected, reducing FPS", {
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

      await captureFrame(
        index,
        Math.min(duration - epsilon, index * frameInterval)
      );
    }

    logger.info(
      "conversion",
      `WebCodecs seek-based capture completed: capturedFrames=${totalFrames}, totalFrames=${totalFrames}`,
      {
        capturedFrames: totalFrames,
        totalFrames,
        elapsedMs: Date.now() - start,
      }
    );
  }
}
