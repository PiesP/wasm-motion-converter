/**
 * Demuxer-based Capture Adapter
 *
 * Uses external demuxer + WebCodecs VideoDecoder to extract frames.
 * Bypasses HTMLVideoElement entirely, eliminating seek overhead for complex codecs.
 *
 * Features:
 * - Direct demuxer → VideoDecoder pipeline
 * - Hardware acceleration preference
 * - Timestamp-based downsampling after decode
 * - Partial result acceptance on flush timeout
 * - Backpressure and memory management
 * - Progressive progress reporting
 *
 * This is the fastest path for AV1/HEVC/VP9 where seeking is extremely slow.
 */

import type { VideoMetadata } from "@t/conversion-types";
import { getErrorMessage } from "@utils/error-utils";
import { logger } from "@utils/logger";

import {
  canvasToBlob,
  createCanvas,
} from "@services/gpu-path/canvas-processor";
import {
  createDemuxer,
  detectContainer,
} from "@services/webcodecs/demuxer/demuxer-factory";

/**
 * Frame payload delivered to capture callback
 */
export interface DemuxerFramePayload {
  /** Frame filename */
  name: string;
  /** Encoded frame data (PNG/JPEG/WebP bytes) */
  data?: Uint8Array;
  /** Raw RGBA pixel data */
  imageData?: ImageData;
  /** Zero-based frame index */
  index: number;
  /** Frame timestamp in seconds */
  timestamp: number;
}

/**
 * Progress callback type
 */
export type DemuxerProgressCallback = (current: number, total: number) => void;

/**
 * Demuxer capture result
 */
export interface DemuxerCaptureResult {
  frameFiles: string[];
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
}

/**
 * Demuxer-based capture adapter
 *
 * NOT implementing CaptureAdapter because it has a different API
 * (takes File instead of HTMLVideoElement, returns detailed result)
 */
export class DemuxerCaptureAdapter {
  /**
   * Capture frames using external demuxer + WebCodecs VideoDecoder
   *
   * @param file - Video file to demux
   * @param targetFps - Target frames per second
   * @param scale - Scale factor (0.0-1.0)
   * @param frameFormat - Output frame format (png, jpeg, rgba)
   * @param framePrefix - Frame filename prefix
   * @param frameDigits - Zero-padded digits in filename
   * @param frameStartNumber - Starting frame number
   * @param maxFrames - Optional maximum frame count
   * @param quality - Conversion quality level
   * @param onFrame - Frame callback
   * @param onProgress - Progress callback
   * @param shouldCancel - Cancellation check
   * @param metadata - Optional video metadata
   * @returns Capture result or null if demuxer unavailable
   */
  async capture(
    file: File,
    targetFps: number,
    scale: number,
    frameFormat: "png" | "jpeg" | "rgba",
    framePrefix: string,
    frameDigits: number,
    frameStartNumber: number,
    maxFrames: number | undefined,
    quality: "low" | "medium" | "high" | undefined,
    onFrame: (frame: DemuxerFramePayload) => Promise<void>,
    onProgress?: DemuxerProgressCallback,
    shouldCancel?: () => boolean,
    metadata?: VideoMetadata
  ): Promise<DemuxerCaptureResult | null> {
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

      // Dev-only diagnostics (rate-limited)
      const isDev = import.meta.env.DEV;
      const decodeStartedAtMs = Date.now();
      let lastOutputAtMs = decodeStartedAtMs;
      let outputFramesTotal = 0;
      let lastDevStatsAtMs = 0;
      const DevStatsIntervalMs = 2000;

      // Downsampling parameters
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

      // Partial acceptance thresholds
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

      // Progress keepalive
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

        // Map sample progress into frame-progress shape
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
      decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          decodedFrames.push(frame);
          outputFramesTotal += 1;
          lastOutputAtMs = Date.now();
        },
        error: (error: Error) => {
          const wrapped =
            error instanceof Error ? error : new Error(getErrorMessage(error));
          decoderError = wrapped;
          logger.error("conversion", "VideoDecoder error", {
            error: getErrorMessage(wrapped),
          });
        },
      });

      // Select decoder config (prefer hardware)
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

        // Snapshot to avoid races with synchronous output callback
        const framesToProcess = decodedFrames.splice(0);

        for (const videoFrame of framesToProcess) {
          try {
            if (shouldCancel?.()) {
              throw new Error("Conversion cancelled by user");
            }

            if (decoderError) {
              throw decoderError;
            }

            // Stop capturing once we've hit our output budget
            if (frameIndex >= totalFrames) {
              continue;
            }

            const timestampMicros = videoFrame.timestamp;
            if (baseTimestampMicros === null) {
              baseTimestampMicros = timestampMicros;
              nextCaptureTimestampMicros = timestampMicros;
            }

            // Respect requested time window
            if (
              timestampMicros >
              baseTimestampMicros +
                maxDurationMicros +
                durationSlackMicros +
                captureIntervalMicros
            ) {
              continue;
            }

            // Timestamp-based sampling
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

            // Extract frame data
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
            const frameName = `${framePrefix}${String(
              frameStartNumber + frameIndex
            ).padStart(frameDigits, "0")}.${actualFormat}`;

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

            // Advance capture cursor
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

      // Decode loop with backpressure
      const MaxDecodeQueueSize = 16;
      const MaxPendingOutputFrames = 6;
      let needsKeyFrame = true;
      let skippedUntilKey = 0;

      for await (const sample of demuxer.extractSamples(targetFps, maxFrames)) {
        if (shouldCancel?.()) {
          throw new Error("Conversion cancelled by user");
        }

        if (decoderError) {
          throw decoderError;
        }

        // Ensure first chunk is keyframe
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
          throw error instanceof Error
            ? error
            : new Error(getErrorMessage(error));
        }

        if (decoderError) {
          throw decoderError;
        }

        // Process output frames
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

        // Backpressure
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
      await processDecodedFrames();
      maybeLogDevStats("pre-drain");

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
          void flushPromise.catch(() => undefined);
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

            const effectiveFps =
              demuxerMetadata.duration > 0
                ? frameIndex / demuxerMetadata.duration
                : targetFps;

            return {
              frameFiles,
              frameCount: frameIndex,
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
          // Ignore
        }
      }
      decodedFrames.length = 0;

      try {
        decoder?.close();
      } catch {
        // Ignore double-close
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
   * Check if demuxer can be used for this file
   *
   * @param file - Video file
   * @param metadata - Optional metadata
   * @returns True if demuxer is available
   */
  static async canUse(file: File, metadata?: VideoMetadata): Promise<boolean> {
    const demuxer = await createDemuxer(file, metadata);
    if (!demuxer) {
      return false;
    }
    demuxer.destroy();
    return true;
  }

  /**
   * Get container format
   *
   * @param file - Video file
   * @returns Container format string
   */
  static detectContainer(file: File): string {
    return detectContainer(file);
  }
}
