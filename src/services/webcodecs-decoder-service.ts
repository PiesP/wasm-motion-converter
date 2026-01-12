// Internal dependencies

// Type imports
import type { VideoMetadata } from "@t/conversion-types";
import { getErrorMessage } from "@utils/error-utils";
import { FFMPEG_INTERNALS } from "@utils/ffmpeg-constants";
import { logger } from "@utils/logger";

import { canvasToBlob, createCanvas } from "@services/webcodecs/decoder/canvas";
import { waitForEvent } from "@services/webcodecs/decoder/wait-for-event";
import {
  canUseDemuxer,
  createDemuxer,
  detectContainer,
} from "@services/webcodecs/demuxer/demuxer-factory";
import {
  getWebCodecsSupportStatus,
  isWebCodecsCodecSupported,
  isWebCodecsDecodeSupported,
} from "./webcodecs-support-service";

/**
 * Frame format type for WebCodecs output
 * - png: PNG format (lossless, larger file size)
 * - jpeg: JPEG format (lossy compression, smaller file size)
 * - rgba: Raw RGBA pixel data (for in-memory processing)
 */
export type WebCodecsFrameFormat = "png" | "jpeg" | "rgba";

/**
 * Maximum time (ms) allowed for canvas.convertToBlob() operation
 * VP9/complex codecs may stall during GPU->CPU readback; timeout forces fallback to FFmpeg
 */
const CANVAS_ENCODE_TIMEOUT_MS = 5000;

/**
 * Progress callback type for frame extraction
 * Reports current frame count and total expected frames
 */
export type WebCodecsProgressCallback = (
  current: number,
  total: number
) => void;

/**
 * Capture mode for WebCodecs frame extraction
 * - auto: Automatically select best mode (demuxer → track → frame-callback → seek)
 * - demuxer: External library demuxing (mp4box/web-demuxer) - eliminates seeking overhead
 * - frame-callback: Use requestVideoFrameCallback API (Chrome/Edge)
 * - seek: Manual seeking with seeked event (universal fallback)
 * - track: MediaStreamTrackProcessor API (experimental)
 */
export type WebCodecsCaptureMode =
  | "auto"
  | "demuxer"
  | "frame-callback"
  | "seek"
  | "track";

/**
 * Frame payload delivered to onFrame callback
 */
export interface WebCodecsFramePayload {
  /** Frame filename (e.g., 'frame_000001.png') */
  name: string;
  /** Encoded frame data (PNG/JPEG bytes) - undefined for rgba format */
  data?: Uint8Array;
  /** Raw RGBA pixel data - undefined for png/jpeg formats */
  imageData?: ImageData;
  /** Zero-based frame index */
  index: number;
  /** Frame timestamp in seconds */
  timestamp: number;
}

/**
 * Options for WebCodecs video decoding
 */
export interface WebCodecsDecodeOptions {
  /** Input video file */
  file: File;
  /** Target frames per second (frame extraction rate) */
  targetFps: number;
  /** Scale factor (0.0 to 1.0) - 1.0 = original size */
  scale: number;
  /** Output frame format (png, jpeg, or rgba) */
  frameFormat: WebCodecsFrameFormat;
  /** JPEG quality (0.0 to 1.0) - ignored for png/rgba */
  frameQuality: number;
  /** Frame filename prefix (e.g., 'frame_') */
  framePrefix: string;
  /** Number of zero-padded digits in filename (e.g., 6 = '000001') */
  frameDigits: number;
  /** Starting frame number (usually 0) */
  frameStartNumber: number;
  /** Optional maximum frame count (for limiting output) */
  maxFrames?: number;
  /** Frame capture mode (auto, track, frame-callback, seek) */
  captureMode?: WebCodecsCaptureMode;
  /** Optional video codec for timeout optimization (e.g., 'av01', 'vp9', 'avc1') */
  codec?: string;
  /** Conversion quality level (low, medium, high) - determines encoding format */
  quality?: "low" | "medium" | "high";
  /** Callback invoked for each extracted frame */
  onFrame: (frame: WebCodecsFramePayload) => Promise<void>;
  /** Optional progress callback */
  onProgress?: WebCodecsProgressCallback;
  /** Optional cancellation check */
  shouldCancel?: () => boolean;
}

/**
 * Result of WebCodecs video decoding
 */
export interface WebCodecsDecodeResult {
  /** Array of frame filenames */
  frameFiles: string[];
  /** Total number of extracted frames */
  frameCount: number;
  /** Effective capture mode used after auto-selection/fallbacks */
  captureModeUsed?: WebCodecsCaptureMode;
  /** Frame width in pixels (after scaling) */
  width: number;
  /** Frame height in pixels (after scaling) */
  height: number;
  /** Effective frames per second (may differ from requested target in some modes) */
  fps: number;
  /** Video duration in seconds */
  duration: number;
}

/**
 * Maximum consecutive empty frames before failing
 * Reduced from 3 to 2 for faster AV1 codec fallback detection
 */
const MAX_CONSECUTIVE_EMPTY_FRAMES = 2;

/**
 * If requestVideoFrameCallback produces no callbacks within this window,
 * abort the realtime capture attempt so callers can fall back quickly.
 */
const FRAME_CALLBACK_FIRST_FRAME_TIMEOUT_MS = 1500;

/**
 * If playback advances but requestVideoFrameCallback under-produces frames
 * relative to the requested sampling rate, abort quickly and let callers
 * fall back to seek capture.
 */
const FRAME_CALLBACK_LAG_CHECK_INTERVAL_MS = 250;
const FRAME_CALLBACK_LAG_MIN_MEDIA_ADVANCE_SECONDS = 0.75;
const FRAME_CALLBACK_LAG_MIN_EXPECTED_FRAMES = 8;
const FRAME_CALLBACK_LAG_MAX_CAPTURED_FRAMES = 1;

/**
 * Format frame filename
 *
 * Creates zero-padded frame filename (e.g., 'frame_000042.png').
 *
 * @param prefix - Filename prefix
 * @param digits - Number of zero-padded digits
 * @param index - Frame index
 * @param extension - File extension
 * @returns Formatted filename
 */
const formatFrameName = (
  prefix: string,
  digits: number,
  index: number,
  extension: string
): string => `${prefix}${String(index).padStart(digits, "0")}.${extension}`;

/**
 * Normalize video duration
 *
 * Ensures duration is a finite number, returns 0 for invalid values.
 *
 * @param duration - Raw duration value
 * @returns Normalized duration (0 if not finite)
 */
const normalizeDuration = (duration: number): number =>
  Number.isFinite(duration) ? duration : 0;

/**
 * WebCodecs Decoder Service
 *
 * Provides GPU-accelerated video frame extraction using WebCodecs API.
 * Supports multiple capture modes with automatic fallback:
 * - Track processor (fastest, experimental)
 * - Frame callback (Chrome/Edge, recommended)
 * - Manual seeking (universal fallback)
 *
 * Features:
 * - Hardware-accelerated video decoding
 * - Multiple output formats (PNG, JPEG, RGBA)
 * - Automatic codec compatibility detection
 * - Empty frame detection with fast AV1 fallback
 * - Cancellation support
 * - Progress reporting
 *
 * @see webcodecs-conversion-service.ts for usage examples
 */
export class WebCodecsDecoderService {
  private activeUrls = new Set<string>();

  /**
   * Check if WebCodecs decoding is supported
   *
   * Validates browser support for required APIs:
   * - HTMLVideoElement, HTMLCanvasElement
   * - WebCodecs VideoDecoder API
   *
   * @returns True if WebCodecs decoding is available
   */
  static isSupported(): boolean {
    return (
      typeof document !== "undefined" &&
      typeof HTMLVideoElement !== "undefined" &&
      typeof HTMLCanvasElement !== "undefined" &&
      isWebCodecsDecodeSupported()
    );
  }

  /**
   * Check if specific codec is supported
   *
   * Tests codec support using VideoDecoder.isConfigSupported().
   *
   * @param codec - Video codec string (e.g., 'avc1', 'vp09', 'av01')
   * @param fileType - MIME type of video file
   * @param metadata - Optional video metadata
   * @returns Promise that resolves to true if codec is supported
   */
  static async isCodecSupported(
    codec: string,
    fileType: string,
    metadata?: VideoMetadata
  ): Promise<boolean> {
    return isWebCodecsCodecSupported(codec, fileType, metadata);
  }

  /**
   * Decode video to frames
   *
   * Main entry point for WebCodecs frame extraction.
   * Automatically selects best capture mode and handles fallbacks.
   *
   * @param options - Decode options with file, fps, scale, format, callbacks
   * @returns Promise with decode result (frame files, count, dimensions, fps, duration)
   * @throws Error if WebCodecs not supported or decode fails
   *
   * @example
   * ```typescript
   * const decoder = new WebCodecsDecoderService();
   * const result = await decoder.decodeToFrames({
   *   file: videoFile,
   *   targetFps: 15,
   *   scale: 1.0,
   *   frameFormat: 'png',
   *   frameQuality: 0.95,
   *   framePrefix: 'frame_',
   *   frameDigits: 6,
   *   frameStartNumber: 0,
   *   captureMode: 'auto',
   *   onFrame: async (frame) => { },
   *   onProgress: (current, total) => { }
   * });
   * ```
   */
  async decodeToFrames(
    options: WebCodecsDecodeOptions
  ): Promise<WebCodecsDecodeResult> {
    if (!WebCodecsDecoderService.isSupported()) {
      throw new Error(
        "WebCodecs decode path is not supported in this browser."
      );
    }

    const {
      file,
      targetFps,
      scale,
      frameFormat,
      frameQuality,
      framePrefix,
      frameDigits,
      frameStartNumber,
      maxFrames,
      captureMode = "auto",
      codec,
      quality,
      onFrame,
      onProgress,
      shouldCancel,
    } = options;

    // Some demuxer eligibility checks benefit from having a codec value available.
    // We pass a minimal metadata object so canUseDemuxer() can log and filter more accurately.
    const demuxerMetadata: VideoMetadata | undefined = codec
      ? {
          width: 0,
          height: 0,
          duration: 0,
          codec,
          framerate: 0,
          bitrate: 0,
        }
      : undefined;

    // Priority 1: Try demuxer path first (eliminates seeking overhead for AV1/HEVC/VP9)
    // Only attempt if captureMode is 'auto' or explicitly 'demuxer'
    if (captureMode === "demuxer" && !canUseDemuxer(file, demuxerMetadata)) {
      throw new Error(
        "Demuxer capture mode requested but is not available for this file."
      );
    }

    if (
      (captureMode === "auto" || captureMode === "demuxer") &&
      canUseDemuxer(file, demuxerMetadata)
    ) {
      try {
        logger.info("conversion", "Attempting demuxer-based frame capture", {
          fileName: file.name,
          container: detectContainer(file),
          codec: codec ?? "unknown",
        });

        const demuxerResult = await this.captureWithDemuxer(
          file,
          targetFps,
          scale,
          frameFormat,
          frameQuality,
          framePrefix,
          frameDigits,
          frameStartNumber,
          maxFrames,
          quality,
          onFrame,
          onProgress,
          shouldCancel,
          demuxerMetadata
        );

        if (demuxerResult) {
          logger.info("conversion", "Demuxer capture completed successfully", {
            frameCount: demuxerResult.frameCount,
            duration: demuxerResult.duration,
          });
          return demuxerResult;
        }
      } catch (error) {
        logger.warn(
          "conversion",
          "Demuxer path failed, falling back to playback modes",
          {
            error: getErrorMessage(error),
            codec: codec ?? "unknown",
          }
        );

        // If the caller explicitly requested demuxer mode, do not silently fall back.
        // This lets higher-level routing choose the next best strategy deterministically.
        if (captureMode === "demuxer") {
          throw error;
        }
        // Fall through to HTMLVideoElement-based capture modes
      }
    }

    // Priority 2-4: HTMLVideoElement-based capture modes (existing logic)
    const url = URL.createObjectURL(file);
    this.activeUrls.add(url);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    // IMPORTANT: Keep the video attached to the DOM to reduce throttling.
    // Some browsers aggressively throttle decode / frame callbacks for off-DOM
    // or non-rendered media elements, which can cause severe under-capture.
    // We hide the element off-screen instead of using display:none.
    this.attachVideoForDecode(video);

    try {
      await waitForEvent(
        video,
        "loadedmetadata",
        FFMPEG_INTERNALS.WEBCODECS.METADATA_TIMEOUT_MS
      );
      const duration = normalizeDuration(video.duration);
      const sourceWidth = video.videoWidth || 0;
      const sourceHeight = video.videoHeight || 0;

      if (!sourceWidth || !sourceHeight || !duration) {
        throw new Error("Video metadata not available for hardware decode.");
      }

      if (video.readyState < 2) {
        await waitForEvent(
          video,
          "loadeddata",
          FFMPEG_INTERNALS.WEBCODECS.METADATA_TIMEOUT_MS
        );
      }

      // VP9/HEVC codec workaround: Automatic scale reduction
      // VP9/complex codecs can cause GPU memory pressure & stalls during canvas encoding.
      // Reduce canvas size by 25% (0.75 scale) to alleviate GPU memory bottlenecks.
      const isComplexCodec =
        codec && /vp9|hevc|h\.265|h265|hvc1|hev1/i.test(codec);
      const effectiveScale =
        isComplexCodec && scale >= 0.9 ? scale * 0.75 : scale;

      const targetWidth = Math.max(1, Math.round(sourceWidth * effectiveScale));
      const targetHeight = Math.max(
        1,
        Math.round(sourceHeight * effectiveScale)
      );
      const captureContext = createCanvas(
        targetWidth,
        targetHeight,
        frameFormat === "rgba"
      );

      if (isComplexCodec && effectiveScale !== scale) {
        logger.info("conversion", "Applied VP9/HEVC codec scale reduction", {
          originalScale: scale,
          effectiveScale,
          targetWidth,
          targetHeight,
          codec,
        });
      }
      const frameFiles: string[] = [];
      const estimatedTotalFrames = Math.max(1, Math.ceil(duration * targetFps));
      const totalFrames =
        maxFrames && maxFrames > 0
          ? Math.max(1, Math.min(maxFrames, estimatedTotalFrames))
          : estimatedTotalFrames;

      // Total decode timeout: seeking can legitimately take longer because it performs
      // many discrete seeks (one per frame). Keep fail-fast behavior for realtime modes.
      const computeMaxTotalDecodeMs = (mode: WebCodecsCaptureMode): number => {
        if (mode !== "seek") {
          return FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS;
        }

        // Conservative per-frame budget for seek-based capture.
        // Example: 115 frames → ~230s budget (2s/frame), capped to 240s.
        const perFrameBudgetMs = 2000;
        const estimatedMs = totalFrames * perFrameBudgetMs;
        const upperBoundMs = 240_000;
        return Math.min(
          upperBoundMs,
          Math.max(FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS, estimatedMs)
        );
      };

      let effectiveCaptureMode: WebCodecsCaptureMode = captureMode;
      let maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);

      logger.info(
        "conversion",
        `WebCodecs decode budget: durationSeconds=${duration.toFixed(
          3
        )}, targetFps=${targetFps}, estimatedTotalFrames=${estimatedTotalFrames}, maxFrames=${
          maxFrames ?? "null"
        }, totalFrames=${totalFrames}, scale=${scale}, frameFormat=${frameFormat}, captureMode=${captureMode}`,
        {
          durationSeconds: duration,
          targetFps,
          estimatedTotalFrames,
          maxFrames: maxFrames ?? null,
          totalFrames,
          scale,
          frameFormat,
          captureMode,
        }
      );

      video.currentTime = 0;

      let consecutiveEmptyFrames = 0;
      const startDecodeTime = Date.now();

      const captureFrame = async (index: number, timestamp: number) => {
        if (shouldCancel?.()) {
          throw new Error("Conversion cancelled by user");
        }

        // Fail-fast if decode is taking too long (indicates stall)
        const elapsed = Date.now() - startDecodeTime;
        if (elapsed > maxTotalDecodeMs) {
          throw new Error(
            `WebCodecs decode exceeded ${maxTotalDecodeMs}ms timeout (mode=${effectiveCaptureMode}) at frame ${index}. ` +
              "Codec incompatibility detected. Falling back to FFmpeg."
          );
        }

        captureContext.context.drawImage(
          video,
          0,
          0,
          captureContext.targetWidth,
          captureContext.targetHeight
        );

        let data: Uint8Array | undefined;
        let imageData: ImageData | undefined;

        if (frameFormat === "rgba") {
          imageData = captureContext.context.getImageData(
            0,
            0,
            captureContext.targetWidth,
            captureContext.targetHeight
          );
          if (imageData.data.length === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn(
              "conversion",
              `WebCodecs produced empty RGBA frame ${index}, skipping`,
              {
                consecutiveEmptyFrames,
                maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
              }
            );

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                  "This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg."
              );
            }
            return; // Skip empty frame without emitting
          }
          consecutiveEmptyFrames = 0;
        } else {
          // Determine optimal encoding format based on quality preset & codec
          // Use JPEG for low/medium quality (3-5x faster encoding), PNG for high quality
          // VP9/HEVC: Force JPEG to reduce canvas encoding latency (avoid GPU stalls)
          const forceJpegForComplexCodec = isComplexCodec;
          const shouldUseJpeg =
            forceJpegForComplexCodec ||
            frameFormat === "jpeg" ||
            (frameFormat === "png" &&
              quality &&
              (quality === "low" || quality === "medium"));

          const encodeMimeType = shouldUseJpeg ? "image/jpeg" : "image/png";
          const encodeQuality = shouldUseJpeg
            ? quality === "low"
              ? 0.75 // Low quality: 75% JPEG
              : quality === "medium"
              ? 0.85 // Medium quality: 85% JPEG
              : frameQuality // Fallback to provided frameQuality if available
            : undefined; // PNG: no quality parameter (lossless)

          // Prefer OffscreenCanvas.convertToBlob() when available (non-blocking, faster)
          // Fall back to HTMLCanvasElement.toBlob() for broader compatibility
          // Add timeout to detect GPU stalls (VP9/HEVC can cause blocking encodes)
          const convertBlobWithTimeout = async (): Promise<Blob> => {
            const timeoutPromise = new Promise<Blob>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Canvas encoding timeout (${CANVAS_ENCODE_TIMEOUT_MS}ms) - GPU stall detected`
                    )
                  ),
                CANVAS_ENCODE_TIMEOUT_MS
              )
            );

            if ("convertToBlob" in captureContext.canvas) {
              try {
                const blobPromise = (
                  captureContext.canvas as OffscreenCanvas
                ).convertToBlob({
                  type: encodeMimeType,
                  quality: encodeQuality,
                });
                return Promise.race([blobPromise, timeoutPromise]);
              } catch (offscreenError) {
                // Fall back to canvasToBlob if OffscreenCanvas fails
                logger.debug(
                  "conversion",
                  "OffscreenCanvas.convertToBlob() failed, using fallback",
                  {
                    error: getErrorMessage(offscreenError),
                  }
                );
                const blobPromise = canvasToBlob(
                  captureContext.canvas,
                  encodeMimeType,
                  encodeQuality
                );
                return Promise.race([blobPromise, timeoutPromise]);
              }
            }
            // Fallback to HTMLCanvasElement.toBlob()
            const blobPromise = canvasToBlob(
              captureContext.canvas,
              encodeMimeType,
              encodeQuality
            );
            return Promise.race([blobPromise, timeoutPromise]);
          };

          let blob: Blob;
          try {
            blob = await convertBlobWithTimeout();
          } catch (timeoutError) {
            const errorMsg = getErrorMessage(timeoutError);
            logger.warn(
              "conversion",
              "Canvas encoding timeout detected - likely GPU stall",
              {
                error: errorMsg,
                codec,
                frameIndex: index,
                canvasWidth: captureContext.targetWidth,
                canvasHeight: captureContext.targetHeight,
              }
            );
            // Timeout during canvas encode suggests codec incompatibility or GPU saturation
            throw new Error(
              `Canvas encoding stalled at frame ${index}. ` +
                "This may indicate codec incompatibility or GPU memory exhaustion. Falling back to FFmpeg."
            );
          }

          if (blob.size === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn(
              "conversion",
              `WebCodecs produced empty frame ${index}, skipping`,
              {
                consecutiveEmptyFrames,
                maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
              }
            );

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                  "This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg."
              );
            }
            return; // Skip this empty capture and keep decoding
          }

          data = new Uint8Array(await blob.arrayBuffer());
          if (data.byteLength === 0) {
            consecutiveEmptyFrames += 1;
            logger.warn(
              "conversion",
              `WebCodecs produced empty frame data at ${index}, skipping`,
              {
                consecutiveEmptyFrames,
                maxAllowed: MAX_CONSECUTIVE_EMPTY_FRAMES,
              }
            );

            if (consecutiveEmptyFrames >= MAX_CONSECUTIVE_EMPTY_FRAMES) {
              throw new Error(
                `WebCodecs decoder produced ${consecutiveEmptyFrames} consecutive empty frames at frame ${index}. ` +
                  "This typically indicates codec incompatibility (e.g., AV1). Falling back to FFmpeg."
              );
            }
            return;
          }
          consecutiveEmptyFrames = 0; // Reset counter on successful frame
        }

        // Use actual encoded format for filename extension to match blob content
        // Critical: FFmpeg PNG decoder fails on JPEG data (signature 0xFFD8FFE0 vs 0x89504E47)
        const actualFormat =
          frameFormat === "jpeg"
            ? "jpeg"
            : quality && (quality === "low" || quality === "medium")
            ? "jpeg"
            : "png";
        const frameName = formatFrameName(
          framePrefix,
          frameDigits,
          frameStartNumber + index,
          actualFormat
        );
        try {
          await onFrame({ name: frameName, data, imageData, index, timestamp });
        } catch (frameCallbackError) {
          throw new Error(
            `onFrame callback failed at frame ${index}: ` +
              (frameCallbackError instanceof Error
                ? frameCallbackError.message
                : String(frameCallbackError))
          );
        }
        frameFiles.push(frameName);
        onProgress?.(frameFiles.length, totalFrames);
      };

      const supportStatus = getWebCodecsSupportStatus();
      const supportsFrameCallback =
        typeof video.requestVideoFrameCallback === "function";
      const supportsTrackProcessor =
        supportStatus.trackProcessor && supportStatus.captureStream;

      if (captureMode === "track") {
        if (!supportsTrackProcessor) {
          throw new Error(
            "WebCodecs track processor is not supported in this browser."
          );
        }
        effectiveCaptureMode = "track";
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithTrackProcessor(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames
        );
      } else if (captureMode === "frame-callback") {
        if (!supportsFrameCallback) {
          throw new Error(
            "requestVideoFrameCallback is not supported in this browser."
          );
        }
        effectiveCaptureMode = "frame-callback";
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithFrameCallback(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      } else if (captureMode === "seek") {
        effectiveCaptureMode = "seek";
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithSeeking(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      } else if (supportsTrackProcessor) {
        try {
          effectiveCaptureMode = "track";
          maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
          await this.captureWithTrackProcessor(
            video,
            duration,
            targetFps,
            captureFrame,
            shouldCancel,
            totalFrames
          );
        } catch (error) {
          const errorMsg = getErrorMessage(error);
          const errorStack = error instanceof Error ? error.stack : "";
          logger.warn(
            "conversion",
            "WebCodecs track capture failed, falling back",
            {
              error: errorMsg,
              supportsFrameCallback,
              stack: errorStack,
            }
          );
          if (supportsFrameCallback) {
            logger.info(
              "conversion",
              "WebCodecs decoder: Attempting frame-callback fallback mode",
              {}
            );
            effectiveCaptureMode = "frame-callback";
            maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
            await this.captureWithFrameCallback(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel,
              totalFrames
            );
          } else {
            logger.info(
              "conversion",
              "WebCodecs decoder: frame-callback not supported, using seek fallback",
              {}
            );
            effectiveCaptureMode = "seek";
            maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
            await this.captureWithSeeking(
              video,
              duration,
              targetFps,
              captureFrame,
              shouldCancel,
              totalFrames
            );
          }
        }
      } else if (supportsFrameCallback) {
        effectiveCaptureMode = "frame-callback";
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithFrameCallback(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      } else {
        effectiveCaptureMode = "seek";
        maxTotalDecodeMs = computeMaxTotalDecodeMs(effectiveCaptureMode);
        await this.captureWithSeeking(
          video,
          duration,
          targetFps,
          captureFrame,
          shouldCancel,
          totalFrames,
          codec
        );
      }

      return {
        frameFiles,
        frameCount: frameFiles.length,
        captureModeUsed: effectiveCaptureMode,
        width: targetWidth,
        height: targetHeight,
        fps: targetFps,
        duration,
      };
    } finally {
      this.cleanupVideo(video, url);
    }
  }

  private attachVideoForDecode(video: HTMLVideoElement): void {
    if (typeof document === "undefined") {
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
      video.style.position = "fixed";
      // Keep the element inside the viewport so browsers treat it as "rendered".
      // Some engines may throttle frame callbacks and captureStream for offscreen
      // or fully transparent videos, which can cause severe under-capture.
      video.style.right = "0";
      video.style.bottom = "0";
      video.style.width = "2px";
      video.style.height = "2px";
      // Avoid fully transparent (0) to reduce the chance of "not painted" optimizations.
      video.style.opacity = "0.001";
      video.style.pointerEvents = "none";
      video.style.zIndex = "0";
      video.style.background = "transparent";
      video.style.contain = "strict";
      video.style.transform = "translateZ(0)";
      body.appendChild(video);
    } catch (error) {
      logger.debug("conversion", "Failed to attach video element for decode", {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Capture frames using requestVideoFrameCallback
   *
   * Uses Chrome/Edge's requestVideoFrameCallback API for precise frame timing.
   * Falls back to seek-based capture if autoplay is blocked.
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   */
  private async captureWithFrameCallback(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean,
    maxFrames?: number,
    codec?: string
  ): Promise<void> {
    const start = Date.now();
    try {
      await video.play();
    } catch (error) {
      logger.warn(
        "conversion",
        "Autoplay blocked, falling back to seek capture",
        {
          error: getErrorMessage(error),
        }
      );
      await this.captureWithSeeking(
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
    // Using captureTimestamp + frameInterval accumulates jitter (drift) and can cause
    // uneven frame selection for complex codecs and downsampled captures.
    // We instead anchor the schedule to t=0 and compute thresholds from the frame index.
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
          reject(new Error("WebCodecs frame capture stalled."));
        }, FFMPEG_INTERNALS.WEBCODECS.FRAME_STALL_TIMEOUT_MS);
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
            "conversion",
            "WebCodecs frame-callback produced no frames quickly; aborting to allow fallback",
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

          // Only bail out when playback is clearly advancing but rVFC isn't producing frames.
          const mediaTime = Number.isFinite(video.currentTime)
            ? video.currentTime
            : 0;
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
            "conversion",
            "WebCodecs frame-callback is lagging far behind playback; aborting to allow fallback",
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

      const finalize = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearStallTimer();
        clearFirstFrameTimer();
        clearLagMonitor();
        video.removeEventListener("ended", handleEnded);
        video.removeEventListener("error", handleError);
        resolve();
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
        reject(new Error("WebCodecs video decode error."));
      };

      video.addEventListener("ended", handleEnded, { once: true });
      video.addEventListener("error", handleError, { once: true });
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
            reject(new Error("Conversion cancelled by user"));
            return;
          }

          // If rVFC is working, we'll see frames very quickly.
          // Once we observe the first frame, stop the bailout timer.
          if (frameIndex === 0) {
            clearFirstFrameTimer();
          }

          const mediaTime = metadata.mediaTime ?? video.currentTime;
          const shouldCapture =
            frameIndex === 0 || mediaTime + epsilon >= nextFrameTime;

          if (shouldCapture) {
            const captureTimestamp = Math.max(0, mediaTime);
            await captureFrame(frameIndex, captureTimestamp);
            frameIndex += 1;
            nextFrameTime = frameIndex * frameInterval;
            scheduleStallTimer();
          }

          if (
            frameIndex >= totalFrames ||
            mediaTime + epsilon >= duration ||
            video.ended
          ) {
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
      "conversion",
      `WebCodecs frame-callback capture completed: capturedFrames=${frameIndex}, totalFrames=${totalFrames}`,
      {
        capturedFrames: frameIndex,
        totalFrames,
        elapsedMs: Date.now() - start,
      }
    );
  }

  /**
   * Capture frames using MediaStreamTrackProcessor
   *
   * Uses experimental MediaStreamTrackProcessor API for hardware-accelerated capture.
   * Requires MediaStream.captureStream() support.
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   * @throws Error if track processor not available or autoplay blocked
   */
  private async captureWithTrackProcessor(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
    shouldCancel?: () => boolean,
    maxFrames?: number
  ): Promise<void> {
    if (
      typeof MediaStreamTrackProcessor === "undefined" ||
      typeof (video as unknown as Record<string, unknown>).captureStream !==
        "function"
    ) {
      throw new Error(
        "WebCodecs track processor is not available in this browser."
      );
    }

    try {
      await video.play();
    } catch (error) {
      logger.warn("conversion", "Autoplay blocked for track capture", {
        error: getErrorMessage(error),
      });
      throw error;
    }

    const stream = (
      video as unknown as { captureStream(): MediaStream }
    ).captureStream();
    const [track] = stream.getVideoTracks();
    if (!track) {
      throw new Error("No video track available for WebCodecs capture.");
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
    // Anchor the sampling schedule to the first observed timestamp to avoid
    // accidental oversampling (capturing too many frames too fast) when the
    // initial timestamp is far from 0.
    let baseTimestampUs: number | null = null;
    let nextFrameTimeUs = 0;
    let frameIndex = 0;
    const startDecodeTime = Date.now();

    const readFrame = async (): Promise<
      ReadableStreamReadResult<VideoFrame>
    > => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<VideoFrame>>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new Error("WebCodecs track capture stalled."));
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
          throw new Error("Conversion cancelled by user");
        }

        const elapsed = Date.now() - startDecodeTime;
        if (elapsed > FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS) {
          throw new Error(
            `WebCodecs decode exceeded ${FFMPEG_INTERNALS.WEBCODECS.MAX_TOTAL_DECODE_MS}ms timeout at frame ${frameIndex}. ` +
              "Codec incompatibility detected. Falling back to FFmpeg."
          );
        }

        const { value: frame, done } = await readFrame();
        if (done || !frame) {
          break;
        }

        try {
          const timestampUs =
            typeof frame.timestamp === "number"
              ? frame.timestamp
              : Math.round(video.currentTime * 1_000_000);

          if (baseTimestampUs === null) {
            baseTimestampUs = timestampUs;
            nextFrameTimeUs = baseTimestampUs;
          }

          const shouldCapture =
            frameIndex === 0 || timestampUs + epsilonUs >= nextFrameTimeUs;

          if (shouldCapture) {
            const captureTimestampSeconds = Math.max(
              0,
              timestampUs / 1_000_000
            );
            await captureFrame(frameIndex, captureTimestampSeconds);
            frameIndex += 1;
            nextFrameTimeUs =
              (baseTimestampUs ?? 0) + frameIndex * frameIntervalUs;
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
        "conversion",
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

  /**
   * Capture frames using manual seeking
   *
   * Universal fallback method that works in all browsers.
   * Seeks to each frame position and captures after 'seeked' event.
   * For single-frame extraction, seeks to 25% duration for better representation.
   *
   * @param video - Video element to capture from
   * @param duration - Video duration in seconds
   * @param targetFps - Target frames per second
   * @param captureFrame - Callback to invoke for each frame
   * @param shouldCancel - Optional cancellation check
   * @param maxFrames - Optional maximum frame count
   */
  private async captureWithSeeking(
    video: HTMLVideoElement,
    duration: number,
    targetFps: number,
    captureFrame: (index: number, timestamp: number) => Promise<void>,
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

  /**
   * Capture frames using external demuxer + WebCodecs VideoDecoder
   *
   * This method bypasses HTMLVideoElement entirely, extracting encoded samples
   * directly from the container and feeding them to VideoDecoder. This eliminates
   * seek overhead for codecs like AV1 where seeking is extremely slow.
   *
   * @param file - Video file to demux
   * @param targetFps - Target frames per second
   * @param scale - Scale factor (0.0-1.0)
   * @param frameFormat - Output frame format (png, jpeg, rgba)
   * @param frameQuality - JPEG quality (0.0-1.0)
   * @param framePrefix - Frame filename prefix
   * @param frameDigits - Zero-padded digits in filename
   * @param frameStartNumber - Starting frame number
   * @param maxFrames - Optional maximum frame count
   * @param quality - Conversion quality level
   * @param onFrame - Frame callback
   * @param onProgress - Progress callback
   * @param shouldCancel - Cancellation check
   * @returns Decode result or null if demuxer unavailable
   */
  private async captureWithDemuxer(
    file: File,
    targetFps: number,
    scale: number,
    frameFormat: WebCodecsFrameFormat,
    _frameQuality: number,
    framePrefix: string,
    frameDigits: number,
    frameStartNumber: number,
    maxFrames: number | undefined,
    quality: "low" | "medium" | "high" | undefined,
    onFrame: (frame: WebCodecsFramePayload) => Promise<void>,
    onProgress?: WebCodecsProgressCallback,
    shouldCancel?: () => boolean,
    metadata?: VideoMetadata
  ): Promise<WebCodecsDecodeResult | null> {
    const demuxer = await createDemuxer(file, metadata);
    if (!demuxer) {
      return null;
    }

    let decoder: VideoDecoder | null = null;
    let decoderError: Error | null = null;
    const decodedFrames: VideoFrame[] = [];
    const frameFiles: string[] = [];
    let frameIndex = 0;

    try {
      // 1. Initialize demuxer and get video configuration
      const decoderConfig = await demuxer.initialize(file);
      const demuxerMetadata = demuxer.getMetadata();

      const targetWidth = Math.max(
        1,
        Math.round(decoderConfig.codedWidth * scale)
      );
      const targetHeight = Math.max(
        1,
        Math.round(decoderConfig.codedHeight * scale)
      );
      const totalFrames =
        maxFrames ?? Math.ceil(demuxerMetadata.duration * targetFps);
      const requiredFramesForSuccess = Math.max(1, totalFrames - 1);

      // Dev-only diagnostics (rate-limited) to help debug demuxer decode stalls.
      const isDev = import.meta.env.DEV;
      const decodeStartedAtMs = Date.now();
      let lastOutputAtMs = decodeStartedAtMs;
      let outputFramesTotal = 0;
      let lastDevStatsAtMs = 0;
      const DevStatsIntervalMs = 5000;

      // When using a demuxer, we must decode all encoded samples in the time window
      // to preserve reference chains. We downsample AFTER decode by selecting decoded
      // frames based on timestamps.
      const captureIntervalMicros = Math.max(
        1,
        Math.round(1_000_000 / targetFps)
      );
      const maxDurationSeconds = maxFrames
        ? maxFrames / targetFps
        : demuxerMetadata.duration;
      const maxDurationMicros = Math.round(maxDurationSeconds * 1_000_000);
      const durationSlackMicros = Math.round(1_000_000);
      let baseTimestampMicros: number | null = null;
      let nextCaptureTimestampMicros: number | null = null;
      let lastCapturedTimestampMicros: number | null = null;

      // If flush() hangs, prefer a partial demuxer result over a slow seek fallback,
      // but only when we captured enough frames and covered (most of) the time window.
      const PartialAcceptRatio = 0.75;
      const partialAcceptFrames = Math.max(
        2,
        Math.min(
          totalFrames,
          Math.max(8, Math.floor(totalFrames * PartialAcceptRatio))
        )
      );

      const hasCoveredTimeWindow = (): boolean => {
        if (
          baseTimestampMicros === null ||
          lastCapturedTimestampMicros === null
        ) {
          return false;
        }

        const targetEndMicros = baseTimestampMicros + maxDurationMicros;
        const toleranceMicros = Math.max(
          captureIntervalMicros,
          Math.round(durationSlackMicros / 2)
        );
        return lastCapturedTimestampMicros >= targetEndMicros - toleranceMicros;
      };

      const canAcceptPartial = (): boolean => frameIndex >= partialAcceptFrames;

      // Progress keepalive: demuxer decoding can continue long after we stop incrementing
      // frameIndex (once the output budget is reached). Without periodic progress reports,
      // the shared watchdog can incorrectly terminate the run.
      const estimatedSamplesTotal = Math.max(
        1,
        Math.min(
          demuxerMetadata.sampleCount,
          Math.ceil(
            maxDurationSeconds *
              Math.max(
                1,
                demuxerMetadata.framerate ??
                  demuxerMetadata.sampleCount / maxDurationSeconds
              )
          )
        )
      );
      let processedSamples = 0;
      let lastProgressTickAt = 0;
      const ProgressTickIntervalMs = 400;

      const tickProgress = (forceComplete = false) => {
        if (!onProgress) {
          return;
        }

        if (forceComplete) {
          onProgress(totalFrames, totalFrames);
          return;
        }

        const now = Date.now();
        if (now - lastProgressTickAt < ProgressTickIntervalMs) {
          return;
        }
        lastProgressTickAt = now;

        // Map sample progress into the expected frame-progress shape.
        const ratio = processedSamples / estimatedSamplesTotal;
        const pseudoCurrent = Math.max(
          0,
          Math.min(
            Math.max(0, totalFrames - 1),
            Math.floor(
              Math.min(1, Math.max(0, ratio)) * Math.max(1, totalFrames)
            )
          )
        );
        onProgress(pseudoCurrent, totalFrames);
      };

      logger.info("conversion", "Demuxer initialized", {
        codec: decoderConfig.codec,
        width: decoderConfig.codedWidth,
        height: decoderConfig.codedHeight,
        duration: demuxerMetadata.duration,
        sourceFps: demuxerMetadata.framerate,
        targetFps,
        totalFrames,
      });

      const maybeLogDevStats = (
        phase: string,
        extra?: Record<string, unknown>
      ) => {
        if (!isDev) {
          return;
        }

        const now = Date.now();
        if (now - lastDevStatsAtMs < DevStatsIntervalMs) {
          return;
        }
        lastDevStatsAtMs = now;

        logger.debug("conversion", "Demuxer decode stats", {
          phase,
          elapsedMs: now - decodeStartedAtMs,
          processedSamples,
          estimatedSamplesTotal,
          frameIndex,
          requiredFramesForSuccess,
          totalFrames,
          decodedFramesBuffered: decodedFrames.length,
          outputFramesTotal,
          decodeQueueSize: decoder?.decodeQueueSize ?? null,
          msSinceLastOutput: now - lastOutputAtMs,
          ...extra,
        });
      };

      // 2. Create canvas for frame capture
      const captureContext = createCanvas(
        targetWidth,
        targetHeight,
        frameFormat === "rgba"
      );
      const shouldUseJpeg =
        frameFormat !== "rgba" && (quality === "low" || quality === "medium");

      // 3. Create VideoDecoder
      // Collect decoded frames and process them after batched flushes.
      // Flushing once per sample is significantly slower on some browsers.
      decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          decodedFrames.push(frame);
          outputFramesTotal += 1;
          lastOutputAtMs = Date.now();
        },
        error: (error: Error) => {
          // Do not throw from this callback. It can surface as an uncaught
          // exception and bypass our async error handling.
          const wrapped =
            error instanceof Error ? error : new Error(getErrorMessage(error));
          decoderError = wrapped;
          logger.error("conversion", "VideoDecoder error", {
            error: getErrorMessage(wrapped),
          });
        },
      });

      // Prefer hardware decoding when possible. Some environments support AV1 playback
      // in <video> but not in WebCodecs, and some support WebCodecs AV1 only in software.
      // This selection improves performance on GPUs that can decode AV1 while preserving
      // a safe fallback.
      const selectDecoderConfig = async (): Promise<VideoDecoderConfig> => {
        if (
          typeof VideoDecoder === "undefined" ||
          typeof VideoDecoder.isConfigSupported !== "function"
        ) {
          return decoderConfig;
        }

        type DecoderConfigWithAcceleration = VideoDecoderConfig & {
          hardwareAcceleration?: "prefer-hardware" | "prefer-software";
        };

        const baseConfig = decoderConfig as DecoderConfigWithAcceleration;

        // If the demuxer already provided a preference, keep it.
        if (baseConfig.hardwareAcceleration) {
          return decoderConfig;
        }

        const candidates: DecoderConfigWithAcceleration[] = [
          { ...baseConfig, hardwareAcceleration: "prefer-hardware" },
          { ...baseConfig, hardwareAcceleration: "prefer-software" },
          baseConfig,
        ];

        for (const candidate of candidates) {
          try {
            const support = await VideoDecoder.isConfigSupported(
              candidate as VideoDecoderConfig
            );
            if (support.supported) {
              if (isDev) {
                logger.debug("conversion", "Selected VideoDecoder config", {
                  codec: candidate.codec,
                  width: candidate.codedWidth,
                  height: candidate.codedHeight,
                  hardwareAcceleration: candidate.hardwareAcceleration ?? null,
                  usedSupportConfig: Boolean(support.config),
                });
              }
              return (support.config ?? candidate) as VideoDecoderConfig;
            }
          } catch (error) {
            if (isDev) {
              logger.debug(
                "conversion",
                "VideoDecoder.isConfigSupported failed for candidate",
                {
                  codec: candidate.codec,
                  hardwareAcceleration: candidate.hardwareAcceleration ?? null,
                  error: getErrorMessage(error),
                }
              );
            }
          }
        }

        return decoderConfig;
      };

      const selectedDecoderConfig = await selectDecoderConfig();
      decoder.configure(selectedDecoderConfig);

      const processDecodedFrames = async () => {
        if (!decodedFrames.length) {
          return;
        }

        if (decoderError) {
          throw decoderError;
        }

        // Snapshot to avoid races with the synchronous output callback.
        const framesToProcess = decodedFrames.splice(0);

        for (const videoFrame of framesToProcess) {
          try {
            if (shouldCancel?.()) {
              throw new Error("Conversion cancelled by user");
            }

            if (decoderError) {
              throw decoderError;
            }

            // Stop capturing once we've hit our output budget.
            if (frameIndex >= totalFrames) {
              continue;
            }

            const timestampMicros = videoFrame.timestamp;
            if (baseTimestampMicros === null) {
              baseTimestampMicros = timestampMicros;
              nextCaptureTimestampMicros = timestampMicros;
            }

            // Respect the requested time window (derived from maxFrames/targetFps).
            if (
              timestampMicros >
              baseTimestampMicros +
                maxDurationMicros +
                durationSlackMicros +
                captureIntervalMicros
            ) {
              continue;
            }

            // Timestamp-based sampling: capture the first decoded frame at/after each interval.
            // Do not capture early, otherwise we may hit the frame budget before we cover
            // the full time window and trigger a fallback.
            const nextTs = nextCaptureTimestampMicros ?? timestampMicros;
            if (timestampMicros < nextTs) {
              continue;
            }

            const timestampSeconds = timestampMicros / 1_000_000;

            // Draw VideoFrame to canvas
            captureContext.context.drawImage(
              videoFrame,
              0,
              0,
              captureContext.targetWidth,
              captureContext.targetHeight
            );

            // Extract frame data (PNG/JPEG/RGBA)
            let data: Uint8Array | undefined;
            let imageData: ImageData | undefined;

            if (frameFormat === "rgba") {
              imageData = captureContext.context.getImageData(
                0,
                0,
                captureContext.targetWidth,
                captureContext.targetHeight
              );
            } else {
              const encodeMimeType = shouldUseJpeg ? "image/jpeg" : "image/png";
              const encodeQuality = shouldUseJpeg
                ? quality === "low"
                  ? 0.75
                  : 0.85
                : undefined;
              const blob = await canvasToBlob(
                captureContext.canvas,
                encodeMimeType,
                encodeQuality
              );
              data = new Uint8Array(await blob.arrayBuffer());
            }

            // Use actual encoded format for filename extension to match blob content
            // Critical: FFmpeg PNG decoder fails on JPEG data (signature 0xFFD8FFE0 vs 0x89504E47)
            const actualFormat =
              frameFormat === "rgba" ? "rgba" : shouldUseJpeg ? "jpeg" : "png";
            const frameName = formatFrameName(
              framePrefix,
              frameDigits,
              frameStartNumber + frameIndex,
              actualFormat
            );

            await onFrame({
              name: frameName,
              data,
              imageData,
              index: frameIndex,
              timestamp: timestampSeconds,
            });

            frameFiles.push(frameName);
            lastCapturedTimestampMicros = timestampMicros;
            frameIndex++;
            onProgress?.(frameIndex, totalFrames);

            // Advance the capture cursor. If the decoded timestamp is far ahead
            // (e.g., variable frame pacing), skip multiple intervals at once.
            if (nextCaptureTimestampMicros !== null) {
              const intervalsPassed = Math.max(
                1,
                Math.floor(
                  (timestampMicros - nextCaptureTimestampMicros) /
                    captureIntervalMicros
                ) + 1
              );
              nextCaptureTimestampMicros +=
                intervalsPassed * captureIntervalMicros;
            }
          } finally {
            videoFrame.close();
          }
        }
      };

      // Some browsers throw if a non-keyframe is decoded immediately after a flush.
      // To maximize compatibility (especially for AV1), we only flush once at the end
      // and apply backpressure via decodeQueueSize + cooperative yielding.
      const MaxDecodeQueueSize = 16;
      const MaxPendingOutputFrames = 6;
      let needsKeyFrame = true;
      let skippedUntilKey = 0;

      // 4. Extract and decode samples
      for await (const sample of demuxer.extractSamples(targetFps, maxFrames)) {
        if (shouldCancel?.()) {
          throw new Error("Conversion cancelled by user");
        }

        if (decoderError) {
          throw decoderError;
        }

        // Ensure the first decoded chunk after configure() is a keyframe.
        if (needsKeyFrame) {
          if (sample.type !== "key") {
            skippedUntilKey += 1;
            processedSamples += 1;
            tickProgress();
            maybeLogDevStats("waiting-for-keyframe", { skippedUntilKey });
            continue;
          }

          if (skippedUntilKey > 0) {
            logger.warn(
              "conversion",
              "Skipping non-key samples until first keyframe",
              {
                skippedSamples: skippedUntilKey,
                codec: decoderConfig.codec,
              }
            );
          }
          needsKeyFrame = false;
        }

        processedSamples += 1;
        tickProgress();
        maybeLogDevStats("decode-loop");

        const chunk = new EncodedVideoChunk({
          type: sample.type,
          timestamp: sample.timestamp,
          duration: sample.duration,
          data: sample.data,
        });

        try {
          decoder.decode(chunk);
        } catch (error) {
          // decoder.decode can throw synchronously (e.g., keyframe required).
          throw error instanceof Error
            ? error
            : new Error(getErrorMessage(error));
        }

        if (decoderError) {
          throw decoderError;
        }

        // Opportunistically process output frames without flushing.
        if (decodedFrames.length >= MaxPendingOutputFrames) {
          await processDecodedFrames();

          maybeLogDevStats("output-drain");

          if (frameIndex >= requiredFramesForSuccess) {
            logger.info(
              "conversion",
              "Demuxer output budget reached; stopping decode early",
              {
                frameCount: frameIndex,
                requiredFrames: requiredFramesForSuccess,
                totalFrames,
                processedSamples,
              }
            );
            break;
          }
        }

        // Backpressure: yield control to allow decoder output callbacks to run.
        if (decoder.decodeQueueSize > MaxDecodeQueueSize) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          await processDecodedFrames();
          tickProgress();
          maybeLogDevStats("backpressure-yield");

          if (frameIndex >= requiredFramesForSuccess) {
            logger.info(
              "conversion",
              "Demuxer output budget reached; stopping decode early",
              {
                frameCount: frameIndex,
                requiredFrames: requiredFramesForSuccess,
                totalFrames,
                processedSamples,
                decodeQueueSize: decoder.decodeQueueSize,
              }
            );
            break;
          }
        }
      }

      // Final drain
      // Always process any frames already emitted.
      await processDecodedFrames();
      maybeLogDevStats("pre-drain");

      // If we already have enough frames (or we covered the time window with a reasonable
      // number of frames), avoid flush(). Some browsers can hang indefinitely in flush()
      // for certain AV1 streams.
      const skipFlush =
        frameIndex >= requiredFramesForSuccess ||
        (hasCoveredTimeWindow() && canAcceptPartial());

      if (skipFlush) {
        tickProgress(true);
      } else {
        const FlushTimeoutMs = 12_000;

        const hasProcessedAllSamples = (): boolean =>
          processedSamples >= estimatedSamplesTotal;

        logger.debug("conversion", "Draining VideoDecoder", {
          frameCount: frameIndex,
          requiredFrames: requiredFramesForSuccess,
          totalFrames,
          processedSamples,
          decodeQueueSize: decoder.decodeQueueSize,
          timeoutMs: FlushTimeoutMs,
        });

        // Some browsers will continue delivering decoded frames while flush() is pending.
        // If we don't actively drain + process those frames, frameIndex can stall and we
        // may incorrectly fall back to a very slow seek-based capture.
        const flushPromise = decoder.flush();
        const flushStartedAtMs = Date.now();
        let flushSettled = false;
        let flushError: unknown | null = null;
        flushPromise.then(
          () => {
            flushSettled = true;
          },
          (error) => {
            flushError = error;
            flushSettled = true;
          }
        );

        const FlushPollIntervalMs = 50;
        while (
          !flushSettled &&
          Date.now() - flushStartedAtMs < FlushTimeoutMs
        ) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, FlushPollIntervalMs)
          );
          await processDecodedFrames();
          tickProgress();
          maybeLogDevStats("drain-wait", {
            flushElapsedMs: Date.now() - flushStartedAtMs,
            baseTimestampMicros,
            lastCapturedTimestampMicros,
          });
        }

        if (!flushSettled) {
          // Suppress potential unhandled rejection if flush later resolves/rejects.
          void flushPromise.catch(() => undefined);

          // Process any frames already emitted while we were waiting.
          await processDecodedFrames();

          logger.warn(
            "conversion",
            "VideoDecoder flush timed out; evaluating partial success",
            {
              frameCount: frameIndex,
              requiredFrames: requiredFramesForSuccess,
              totalFrames,
              partialAcceptFrames,
              processedSamples,
              estimatedSamplesTotal,
              decodeQueueSize: decoder.decodeQueueSize,
              baseTimestampMicros,
              lastCapturedTimestampMicros,
              timeoutMs: FlushTimeoutMs,
            }
          );

          // If we made substantial progress, prefer a partial demuxer result over a slow
          // seek-based fallback. If all samples were already fed, there's little value in
          // redoing extraction via playback.
          const acceptPartial =
            frameIndex >= requiredFramesForSuccess ||
            ((hasCoveredTimeWindow() || hasProcessedAllSamples()) &&
              canAcceptPartial());

          if (acceptPartial) {
            tickProgress(true);

            logger.warn(
              "conversion",
              "Accepting partial demuxer result after flush timeout",
              {
                frameCount: frameIndex,
                totalFrames,
                partialAcceptFrames,
                processedSamples,
                coveredTimeWindow: hasCoveredTimeWindow(),
                processedAllSamples: hasProcessedAllSamples(),
              }
            );

            logger.info("conversion", "Demuxer capture completed (partial)", {
              frameCount: frameIndex,
              duration: demuxerMetadata.duration,
              avgFps: frameIndex / demuxerMetadata.duration,
            });

            const effectiveFps =
              demuxerMetadata.duration > 0
                ? frameIndex / demuxerMetadata.duration
                : targetFps;

            return {
              frameFiles,
              frameCount: frameIndex,
              captureModeUsed: "demuxer",
              width: targetWidth,
              height: targetHeight,
              fps: effectiveFps,
              duration: demuxerMetadata.duration,
            };
          }

          throw new Error(
            `VideoDecoder flush timed out after ${Math.round(
              FlushTimeoutMs / 1000
            )}s`
          );
        }

        if (flushError) {
          throw flushError instanceof Error
            ? flushError
            : new Error(getErrorMessage(flushError));
        }

        maybeLogDevStats("drain-flushed", {
          flushElapsedMs: Date.now() - flushStartedAtMs,
        });

        if (decoderError) {
          throw decoderError;
        }

        await processDecodedFrames();
        tickProgress(true);
      }

      logger.info("conversion", "Demuxer capture completed", {
        frameCount: frameIndex,
        duration: demuxerMetadata.duration,
        avgFps: frameIndex / demuxerMetadata.duration,
      });

      const effectiveFps =
        demuxerMetadata.duration > 0
          ? frameIndex / demuxerMetadata.duration
          : targetFps;

      return {
        frameFiles,
        frameCount: frameIndex,
        captureModeUsed: "demuxer",
        width: targetWidth,
        height: targetHeight,
        fps: effectiveFps,
        duration: demuxerMetadata.duration,
      };
    } finally {
      // Cleanup resources
      for (const frame of decodedFrames) {
        try {
          frame.close();
        } catch {
          // Ignore.
        }
      }
      decodedFrames.length = 0;

      try {
        decoder?.close();
      } catch {
        // Some browsers may close the codec on error; ignore double-close.
      }

      try {
        demuxer?.destroy();
      } catch (error) {
        logger.debug("conversion", "Demuxer destroy failed (non-fatal)", {
          error: getErrorMessage(error),
        });
      }
    }
  }

  /**
   * Seek video to specific time
   *
   * Sets video.currentTime and waits for 'seeked' event.
   * Skips seek if already at target time (within 0.0001s).
   *
   * @param video - Video element to seek
   * @param time - Target time in seconds
   * @throws Error if time is NaN or seek times out
   */
  /**
   * Calculate codec-aware seek timeout
   *
   * AV1 and other complex codecs require more time for seeking due to keyframe complexity.
   * Using a shorter timeout prevents unnecessary waiting on fast seeks.
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
      return 2000; // 2s for AV1/HEVC (reduced from 5s baseline)
    }
    if (isVp9) {
      return 1800; // 1.8s for VP9
    }

    // Simple codecs (H.264, VP8, etc.) seek quickly
    return 1500; // 1.5s for H.264 and other simple codecs
  }

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

    // Prefer fastSeek() when available (can be faster than setting currentTime
    // and waiting for a full seek pipeline in some browsers).
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
   * Clean up video element and revoke object URL
   *
   * Pauses video, removes src, and revokes blob URL to free memory.
   *
   * @param video - Video element to clean up
   * @param url - Blob URL to revoke
   */
  private cleanupVideo(video: HTMLVideoElement, url: string): void {
    const cleanupStart = Date.now();

    try {
      logger.debug("conversion", "WebCodecs: Starting video cleanup");

      // Pause playback
      try {
        video.pause();
        logger.debug("conversion", "WebCodecs: Video paused");
      } catch (error) {
        logger.debug("conversion", "WebCodecs: Failed to pause video", {
          error: getErrorMessage(error),
        });
      }

      // Remove src attribute and clear srcObject
      try {
        video.removeAttribute("src");
        video.srcObject = null;
        logger.debug(
          "conversion",
          "WebCodecs: Src attribute and srcObject cleared"
        );
      } catch (error) {
        logger.debug(
          "conversion",
          "WebCodecs: Failed to remove src attribute/srcObject",
          {
            error: getErrorMessage(error),
          }
        );
      }

      // Trigger media load reset
      try {
        video.load();
        logger.debug("conversion", "WebCodecs: Load called to reset media");
      } catch (error) {
        logger.debug("conversion", "WebCodecs: Failed to call load", {
          error: getErrorMessage(error),
        });
      }

      // Reset media element properties to ensure clean state
      try {
        video.currentTime = 0;
        video.autoplay = false;
        video.controls = false;
        logger.debug("conversion", "WebCodecs: Media element properties reset");
      } catch (error) {
        logger.debug(
          "conversion",
          "WebCodecs: Failed to reset media element properties",
          {
            error: getErrorMessage(error),
          }
        );
      }

      // If we attached the element to the DOM for decode, remove it.
      if (video.parentElement) {
        try {
          video.remove();
          logger.debug(
            "conversion",
            "WebCodecs: Video element removed from DOM"
          );
        } catch (error) {
          logger.debug(
            "conversion",
            "WebCodecs: Failed to remove video from DOM",
            {
              error: getErrorMessage(error),
            }
          );
        }
      }
    } catch (error) {
      logger.debug("conversion", "WebCodecs: Video element cleanup failed", {
        error: getErrorMessage(error),
      });
    }

    // Revoke object URL
    try {
      if (this.activeUrls.has(url)) {
        URL.revokeObjectURL(url);
        this.activeUrls.delete(url);
        logger.debug("conversion", "WebCodecs: Object URL revoked");
      }
    } catch (error) {
      logger.debug("conversion", "WebCodecs: Failed to revoke object URL", {
        error: getErrorMessage(error),
      });
    }

    const cleanupTime = Date.now() - cleanupStart;
    logger.debug("conversion", "WebCodecs: Video cleanup complete", {
      elapsedMs: cleanupTime,
    });
  }
}
