/**
 * Frame Extractor
 *
 * Main entry point for GPU-accelerated frame extraction.
 * Integrates all capture modes (demuxer, track, frame-callback, seek) with
 * automatic mode selection and fallback handling.
 *
 * This replaces the core extraction logic from webcodecs-decoder-service.ts
 * with a cleaner, modular architecture.
 *
 * Features:
 * - Automatic capture mode selection
 * - Demuxer path for complex codecs (AV1/HEVC/VP9)
 * - HTMLVideoElement fallback path
 * - Empty frame detection
 * - Progress reporting
 * - Cancellation support
 */

import type { VideoMetadata } from "@t/conversion-types";
import { getErrorMessage } from "@utils/error-utils";
import { FFMPEG_INTERNALS } from "@utils/ffmpeg-constants";
import { logger } from "@utils/logger";
import { waitForEvent } from "@services/webcodecs/decoder/wait-for-event";
import {
  createCanvas,
  drawVideoFrame,
  encodeCanvasToFormat,
} from "./canvas-processor";
import { captureModeSelector } from "./capture-mode-selector";
import { DemuxerCaptureAdapter } from "./capture-modes/demuxer-capture";
import { FrameCallbackCaptureAdapter } from "./capture-modes/frame-callback-capture";
import { SeekCaptureAdapter } from "./capture-modes/seek-capture";
import { TrackCaptureAdapter } from "./capture-modes/track-capture";
import type { CaptureMode, FrameFormat } from "./types";

/**
 * Frame extraction options
 */
export interface FrameExtractionOptions {
  /** Input video file */
  file: File;
  /** Target frames per second */
  targetFps: number;
  /** Scale factor (0.0 to 1.0) */
  scale: number;
  /** Output frame format */
  frameFormat: FrameFormat;
  /** Frame quality (0.0 to 1.0, for JPEG/WebP) */
  frameQuality?: number;
  /** Frame filename prefix */
  framePrefix?: string;
  /** Number of zero-padded digits */
  frameDigits?: number;
  /** Starting frame number */
  frameStartNumber?: number;
  /** Maximum frames to extract */
  maxFrames?: number;
  /** Capture mode ('auto' for automatic selection) */
  captureMode?: CaptureMode;
  /** Optional codec hint */
  codec?: string;
  /** Conversion quality level */
  quality?: "low" | "medium" | "high";
  /** Video metadata (optional, for optimizations) */
  metadata?: VideoMetadata;
  /** Progress callback */
  onProgress?: (current: number, total: number) => void;
  /** Cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Frame extraction result
 */
export interface FrameExtractionResult {
  /** Frame filenames */
  frameFiles: string[];
  /** Frame count */
  frameCount: number;
  /** Capture mode used */
  captureModeUsed: CaptureMode;
  /** Frame width */
  width: number;
  /** Frame height */
  height: number;
  /** Effective FPS */
  fps: number;
  /** Video duration in seconds */
  duration: number;
}

/**
 * Maximum consecutive empty frames before failing
 */
const MAX_CONSECUTIVE_EMPTY_FRAMES = 2;

/**
 * Frame extractor class
 */
export class FrameExtractor {
  private activeVideoUrls = new Set<string>();
  private demuxerAdapter = new DemuxerCaptureAdapter();
  private trackAdapter = new TrackCaptureAdapter();
  private frameCallbackAdapter = new FrameCallbackCaptureAdapter();
  private seekAdapter = new SeekCaptureAdapter();

  /**
   * Extract frames from video file
   *
   * Main API for frame extraction. Automatically selects best capture mode
   * and handles fallbacks.
   *
   * @param options - Extraction options
   * @returns Promise resolving to extraction result
   */
  async extractFrames(
    options: FrameExtractionOptions
  ): Promise<FrameExtractionResult> {
    const {
      file,
      targetFps,
      scale,
      frameFormat,
      framePrefix = "frame_",
      frameDigits = 6,
      frameStartNumber = 0,
      maxFrames,
      captureMode = "auto",
      quality,
      metadata,
      onProgress,
      shouldCancel,
    } = options;

    // Select capture mode
    const selection = captureModeSelector.selectMode(
      file,
      captureMode,
      metadata
    );
    logger.info("frame-extractor", "Starting frame extraction", {
      file: file.name,
      targetFps,
      scale,
      frameFormat,
      selectedMode: selection.mode,
      reason: selection.reason,
    });

    // Try demuxer path first for eligible files
    if (
      selection.mode === "demuxer" ||
      (selection.mode === "auto" &&
        (await DemuxerCaptureAdapter.canUse(file, metadata)))
    ) {
      try {
        const result = await this.demuxerAdapter.capture(
          file,
          targetFps,
          scale,
          frameFormat,
          framePrefix,
          frameDigits,
          frameStartNumber,
          maxFrames,
          quality,
          async (_frame) => {
            // Demuxer adapter handles frame encoding internally
          },
          onProgress,
          shouldCancel,
          metadata
        );

        if (result) {
          captureModeSelector.recordSuccess(file, "demuxer", metadata);
          return {
            frameFiles: result.frameFiles,
            frameCount: result.frameCount,
            captureModeUsed: "demuxer",
            width: result.width,
            height: result.height,
            fps: result.fps,
            duration: result.duration,
          };
        }
      } catch (error) {
        logger.warn(
          "frame-extractor",
          "Demuxer path failed, falling back to video element",
          {
            error: getErrorMessage(error),
          }
        );
        // Fall through to HTMLVideoElement path
      }
    }

    // HTMLVideoElement-based path
    // At this point, mode should not be 'auto' or 'demuxer' (already tried demuxer above)
    const mode: Exclude<CaptureMode, "auto" | "demuxer"> =
      selection.mode === "auto" || selection.mode === "demuxer"
        ? "seek"
        : selection.mode;
    return this.extractViaVideoElement(options, mode);
  }

  /**
   * Extract frames via HTMLVideoElement
   *
   * Uses track processor, frame callback, or seek capture modes.
   */
  private async extractViaVideoElement(
    options: FrameExtractionOptions,
    selectedMode: Exclude<CaptureMode, "auto" | "demuxer">
  ): Promise<FrameExtractionResult> {
    const {
      file,
      targetFps,
      scale,
      frameFormat,
      frameQuality = 0.95,
      framePrefix = "frame_",
      frameDigits = 6,
      frameStartNumber = 0,
      maxFrames,
      codec,
      quality,
      onProgress,
      shouldCancel,
    } = options;

    const url = URL.createObjectURL(file);
    this.activeVideoUrls.add(url);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    // Attach video to DOM to reduce throttling
    this.attachVideoForDecode(video);

    try {
      // Load metadata
      await waitForEvent(
        video,
        "loadedmetadata",
        FFMPEG_INTERNALS.WEBCODECS.METADATA_TIMEOUT_MS
      );
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const sourceWidth = video.videoWidth || 0;
      const sourceHeight = video.videoHeight || 0;

      if (!sourceWidth || !sourceHeight || !duration) {
        throw new Error("Video metadata not available for frame extraction");
      }

      if (video.readyState < 2) {
        await waitForEvent(
          video,
          "loadeddata",
          FFMPEG_INTERNALS.WEBCODECS.METADATA_TIMEOUT_MS
        );
      }

      const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
      const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
      const captureContext = createCanvas(
        targetWidth,
        targetHeight,
        frameFormat === "rgba"
      );
      const frameFiles: string[] = [];
      const estimatedTotalFrames = Math.max(1, Math.ceil(duration * targetFps));
      const totalFrames =
        maxFrames && maxFrames > 0
          ? Math.max(1, Math.min(maxFrames, estimatedTotalFrames))
          : estimatedTotalFrames;

      let consecutiveEmptyFrames = 0;

      // Frame capture callback
      const captureFrame = async (
        index: number,
        _timestamp: number
      ): Promise<void> => {
        if (shouldCancel?.()) {
          throw new Error("Conversion cancelled by user");
        }

        // Draw frame
        drawVideoFrame(
          captureContext.context,
          video,
          targetWidth,
          targetHeight
        );

        // Encode frame
        let data: Uint8Array | undefined;
        let imageData: ImageData | undefined;

        if (frameFormat === "rgba") {
          imageData = captureContext.context.getImageData(
            0,
            0,
            targetWidth,
            targetHeight
          );
          if (imageData.data.length === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn(
              "frame-extractor",
              `Empty RGBA frame ${index}, skipping`,
              {
                consecutiveEmptyFrames,
                maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
              }
            );

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `Frame extraction produced ${consecutiveEmptyFrames} consecutive empty frames. ` +
                  "This typically indicates codec incompatibility."
              );
            }
            return;
          }
          consecutiveEmptyFrames = 0;
        } else {
          // Determine encoding format based on quality
          const shouldUseJpeg =
            frameFormat === "jpeg" ||
            (frameFormat === "png" &&
              quality &&
              (quality === "low" || quality === "medium"));

          const format = shouldUseJpeg ? "jpeg" : frameFormat;
          const encodeQuality = shouldUseJpeg
            ? quality === "low"
              ? 0.75
              : quality === "medium"
              ? 0.85
              : frameQuality
            : frameQuality;

          data = await encodeCanvasToFormat(
            captureContext.canvas,
            format,
            encodeQuality
          );

          if (data.byteLength === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn("frame-extractor", `Empty frame ${index}, skipping`, {
              consecutiveEmptyFrames,
              maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
            });

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `Frame extraction produced ${consecutiveEmptyFrames} consecutive empty frames. ` +
                  "This typically indicates codec incompatibility."
              );
            }
            return;
          }
          consecutiveEmptyFrames = 0;
        }

        // Use actual encoded format for filename extension to match blob content
        // Critical: FFmpeg PNG decoder fails on JPEG data (signature 0xFFD8FFE0 vs 0x89504E47)
        const actualFormat =
          frameFormat === "jpeg"
            ? "jpeg"
            : frameFormat === "png" &&
              quality &&
              (quality === "low" || quality === "medium")
            ? "jpeg"
            : frameFormat;
        const frameName = `${framePrefix}${String(
          frameStartNumber + index
        ).padStart(frameDigits, "0")}.${actualFormat}`;
        frameFiles.push(frameName);
        onProgress?.(frameFiles.length, totalFrames);
      };

      // Execute capture based on mode (selectedMode is already validated as track/frame-callback/seek)
      let effectiveMode = selectedMode;

      try {
        if (effectiveMode === "track") {
          await this.trackAdapter.capture(
            video,
            duration,
            targetFps,
            captureFrame,
            shouldCancel,
            maxFrames
          );
        } else if (effectiveMode === "frame-callback") {
          await this.frameCallbackAdapter.capture(
            video,
            duration,
            targetFps,
            captureFrame,
            shouldCancel,
            maxFrames,
            codec
          );
        } else {
          await this.seekAdapter.capture(
            video,
            duration,
            targetFps,
            captureFrame,
            shouldCancel,
            maxFrames,
            codec
          );
        }

        // Record success
        captureModeSelector.recordSuccess(
          file,
          effectiveMode,
          options.metadata
        );

        return {
          frameFiles,
          frameCount: frameFiles.length,
          captureModeUsed: effectiveMode,
          width: targetWidth,
          height: targetHeight,
          fps: targetFps,
          duration,
        };
      } catch (error) {
        // Try fallback
        const fallback = captureModeSelector.getNextFallback(effectiveMode);
        if (fallback && fallback !== "auto" && fallback !== "demuxer") {
          logger.warn(
            "frame-extractor",
            `${effectiveMode} mode failed, trying ${fallback}`,
            {
              error: getErrorMessage(error),
            }
          );

          effectiveMode = fallback;

          if (fallback === "frame-callback") {
            await this.frameCallbackAdapter.capture(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel,
              maxFrames,
              codec
            );
          } else if (fallback === "seek") {
            await this.seekAdapter.capture(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel,
              maxFrames,
              codec
            );
          }

          return {
            frameFiles,
            frameCount: frameFiles.length,
            captureModeUsed: effectiveMode,
            width: targetWidth,
            height: targetHeight,
            fps: targetFps,
            duration,
          };
        }

        throw error;
      }
    } finally {
      this.cleanupVideo(video, url);
    }
  }

  /**
   * Attach video to DOM for decode
   *
   * Prevents browser throttling by keeping video in viewport.
   */
  private attachVideoForDecode(video: HTMLVideoElement): void {
    if (
      typeof document === "undefined" ||
      !document.body ||
      video.parentElement
    ) {
      return;
    }

    try {
      video.style.position = "fixed";
      video.style.right = "0";
      video.style.bottom = "0";
      video.style.width = "2px";
      video.style.height = "2px";
      video.style.opacity = "0.001";
      video.style.pointerEvents = "none";
      video.style.zIndex = "0";
      video.style.background = "transparent";
      video.style.contain = "strict";
      video.style.transform = "translateZ(0)";
      document.body.appendChild(video);
    } catch (error) {
      logger.debug("frame-extractor", "Failed to attach video element", {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Clean up video element and URL
   */
  private cleanupVideo(video: HTMLVideoElement, url: string): void {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();

      if (video.parentElement) {
        video.remove();
      }
    } catch (error) {
      logger.debug("frame-extractor", "Video cleanup failed", {
        error: getErrorMessage(error),
      });
    }

    if (this.activeVideoUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.activeVideoUrls.delete(url);
    }
  }

  /**
   * Clean up all resources
   */
  dispose(): void {
    // Cleanup active video URLs
    for (const url of this.activeVideoUrls) {
      URL.revokeObjectURL(url);
    }
    this.activeVideoUrls.clear();

    // Clear performance cache
    captureModeSelector.clearCache();
  }
}

/**
 * Global frame extractor instance
 */
export const frameExtractor = new FrameExtractor();
