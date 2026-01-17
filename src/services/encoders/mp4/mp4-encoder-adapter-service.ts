/**
 * MP4 Encoder Adapter
 *
 * WebCodecs VideoEncoder-based MP4 encoder with H.264 encoding.
 * Encodes frames to MP4 format using browser's hardware-accelerated VideoEncoder API.
 *
 * Features:
 * - Hardware-accelerated H.264 encoding (baseline profile for compatibility)
 * - Automatic codec configuration and bitrate calculation
 * - Frame timing and keyframe insertion
 * - Progressive encoding with real-time progress
 *
 * Limitations:
 * - Main thread only (VideoEncoder is not available in workers)
 * - Requires modern browser with WebCodecs support (Chrome 94+, Edge 94+)
 * - Output muxing is done in-memory (MP4 container via Mediabunny)
 *
 * Architecture:
 * ImageData frames → VideoFrame → VideoEncoder → EncodedVideoChunk → MP4 container
 */

import type { EncoderAdapter, EncoderRequest } from '@services/encoders/encoder-interface-service';
import { convertFramesToImageData } from '@services/encoders/frame-converter-service';
import { logger } from '@utils/logger';

const NO_FRAMES_ERROR = 'No frames to encode';
const ENCODING_CANCELLED_ERROR = 'Encoding cancelled';
const FRAME_UNDEFINED_ERROR = 'Frame is undefined';
const FRAME_CONVERSION_YIELD_INTERVAL = 30;
const MP4_MIN_BITRATE = 500_000;
const MP4_MAX_BITRATE = 20_000_000;

// Type definitions for lazy-loaded mediabunny
type MediabunnyModule = typeof import('mediabunny');

// Cached module reference for lazy loading
let mediabunnyModule: MediabunnyModule | null = null;

/**
 * Lazy-load mediabunny module
 */
async function loadMediabunny(): Promise<MediabunnyModule> {
  if (!mediabunnyModule) {
    logger.debug('mp4-encoder', 'Loading mediabunny module');
    mediabunnyModule = await import('mediabunny');
  }
  return mediabunnyModule;
}

/**
 * MP4 encoder adapter
 *
 * Encodes video frames to MP4 format using WebCodecs VideoEncoder.
 * Uses H.264 codec with baseline profile for maximum compatibility.
 */
export class MP4EncoderAdapter implements EncoderAdapter {
  name = 'mp4-webcodecs';

  capabilities = {
    formats: ['mp4' as const],
    supportsWorkers: false, // VideoEncoder is main-thread only
    requiresSharedArrayBuffer: false,
    maxFrames: undefined, // No practical limit for MP4
    maxDimension: 4096, // WebCodecs typical limit (4K)
    /**
     * Performance score: 9/10 (Very fast)
     *
     * Hardware-accelerated VideoEncoder with H.264 encoding.
     * Native browser API with GPU acceleration for encoding,
     * typically the fastest option for MP4 output.
     */
    performanceScore: 9,
  };

  private encoder: VideoEncoder | null = null;
  private chunks: EncodedVideoChunk[] = [];
  private chunkMetas: Array<EncodedVideoChunkMetadata | undefined> = [];
  private encoderFatalError: Error | null = null;

  /**
   * Check if MP4 encoding is available
   *
   * Requirements:
   * - VideoEncoder API support
   * - H.264 codec support (avc1 baseline profile; level is selected by config)
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check VideoEncoder support
      if (typeof VideoEncoder === 'undefined') {
        logger.debug('mp4-encoder', 'VideoEncoder API not available');
        return false;
      }

      // Check H.264 codec support (baseline profile; choose a safe level).
      // NOTE: We intentionally do not lock this to a single level because
      // moderate resolutions (e.g., 700x700 -> coded 704x704) can exceed Level 3.0.
      const codec = await this.pickSupportedAvc1Codec({
        width: 640,
        height: 480,
        bitrate: 1_000_000,
        framerate: 30,
      });

      if (!codec) {
        logger.debug('mp4-encoder', 'H.264 codec not supported');
        return false;
      }

      logger.debug('mp4-encoder', 'MP4 encoder available (WebCodecs H.264)');
      return true;
    } catch (error) {
      logger.debug('mp4-encoder', 'MP4 encoder availability check failed', {
        error,
      });
      return false;
    }
  }

  /**
   * Encode frames to MP4
   *
   * @param request - Encoding parameters
   * @returns MP4 video blob
   */
  async encode(request: EncoderRequest): Promise<Blob> {
    const { frames, width, height, fps, quality, onProgress, shouldCancel } = request;

    if (frames.length === 0) {
      throw new Error(NO_FRAMES_ERROR);
    }

    logger.info('mp4-encoder', 'Starting MP4 encoding', {
      frameCount: frames.length,
      width,
      height,
      fps,
      quality,
    });

    const startTime = performance.now();

    try {
      this.encoderFatalError = null;

      // Calculate bitrate based on quality and resolution
      const bitrate = this.calculateBitrate(width, height, fps, quality);

      const codec = await this.pickSupportedAvc1Codec({
        width,
        height,
        bitrate,
        framerate: fps,
      });

      if (!codec) {
        throw new Error('No supported H.264 (avc1) encoder config found for this input.');
      }

      // Configure and create encoder
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate: fps,
        hardwareAcceleration: 'prefer-hardware',
        // Baseline profile: no B-frames, simpler encoding
        avc: { format: 'avc' },
      };

      logger.debug('mp4-encoder', 'Creating VideoEncoder', { config });

      this.chunks = [];
      this.chunkMetas = [];
      this.encoder = await this.createEncoder(config);

      // Convert frames to ImageData if needed (VideoFrame/ImageBitmap → ImageData)
      const imageDataFrames = await convertFramesToImageData(
        frames,
        width,
        height,
        undefined, // Don't report conversion progress separately
        shouldCancel
      );

      // Encode frames
      let encodedCount = 0;

      const keyframeIntervalFrames = Math.max(1, Math.round(fps * 2));

      for (let i = 0; i < imageDataFrames.length; i++) {
        if (shouldCancel?.()) {
          throw new Error(ENCODING_CANCELLED_ERROR);
        }

        if (this.encoderFatalError) {
          throw this.encoderFatalError;
        }

        if (!this.encoder || this.encoder.state === 'closed') {
          throw new Error('VideoEncoder is closed; cannot continue encoding.');
        }

        const frame = imageDataFrames[i];
        if (!frame) {
          throw new Error(`${FRAME_UNDEFINED_ERROR}: ${i}`);
        }

        const timestampUs = Math.round((i * 1_000_000) / fps);
        const durationUs = Math.round(1_000_000 / fps);

        // Create VideoFrame from ImageData
        // VideoFrame constructor requires buffer + BufferInit, not ImageData directly
        const videoFrame = new VideoFrame(frame.data, {
          format: 'RGBA',
          codedWidth: width,
          codedHeight: height,
          timestamp: timestampUs,
          duration: durationUs,
        });

        try {
          // Insert keyframe every ~2 seconds
          const isKeyframe = i % keyframeIntervalFrames === 0;

          // Encode frame
          this.encoder.encode(videoFrame, { keyFrame: isKeyframe });
        } catch (error) {
          if (this.encoderFatalError) {
            throw this.encoderFatalError;
          }
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`VideoEncoder.encode failed: ${message}`);
        } finally {
          // Always close VideoFrame (avoids GC warnings and leaks on errors)
          videoFrame.close();
        }

        encodedCount += 1;
        onProgress?.(encodedCount, frames.length);

        // Allow browser to breathe every 30 frames
        if (i % FRAME_CONVERSION_YIELD_INTERVAL === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      // Flush encoder and wait for all chunks
      try {
        await this.encoder.flush();
      } catch (error) {
        if (this.encoderFatalError) {
          throw this.encoderFatalError;
        }
        throw error;
      }

      // Create a proper MP4 file from the encoded chunks
      const blob = await this.muxToMp4Blob({
        chunks: this.chunks,
        chunkMetas: this.chunkMetas,
        fps,
        shouldCancel,
      });

      const duration = performance.now() - startTime;
      logger.performance('MP4 encoding completed', {
        frameCount: frames.length,
        durationMs: Math.round(duration),
        outputSize: blob.size,
        fps,
        bitrate,
      });

      return blob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('mp4-encoder', 'MP4 encoding failed', { error: message });
      throw error;
    } finally {
      await this.dispose();
    }
  }

  /**
   * Calculate bitrate based on resolution, fps, and quality
   */
  private calculateBitrate(
    width: number,
    height: number,
    fps: number,
    quality: 'low' | 'medium' | 'high'
  ): number {
    // Base bitrate: pixels per second * bits per pixel
    const pixelsPerSecond = width * height * fps;

    // Bits per pixel based on quality
    const bitsPerPixel = quality === 'low' ? 0.1 : quality === 'medium' ? 0.15 : 0.2;

    const baseBitrate = pixelsPerSecond * bitsPerPixel;

    // Clamp to reasonable range (500 Kbps to 20 Mbps)
    return Math.max(MP4_MIN_BITRATE, Math.min(MP4_MAX_BITRATE, Math.round(baseBitrate)));
  }

  /**
   * Create VideoEncoder with error handling
   */
  private async createEncoder(config: VideoEncoderConfig): Promise<VideoEncoder> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          this.chunks.push(chunk);
          this.chunkMetas.push(metadata);

          // Log first chunk metadata for debugging
          if (this.chunks.length === 1 && metadata) {
            logger.debug('mp4-encoder', 'First chunk encoded', {
              type: chunk.type,
              timestamp: chunk.timestamp,
              byteLength: chunk.byteLength,
              metadata,
            });
          }
        },
        error: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('mp4-encoder', 'VideoEncoder error', { error: message });

          const fatal = new Error(`VideoEncoder error: ${message}`);
          this.encoderFatalError = fatal;

          try {
            if (encoder.state !== 'closed') {
              encoder.close();
            }
          } catch {
            // ignore
          }

          if (!resolved) {
            resolved = true;
            reject(fatal);
          }
        },
      });

      try {
        encoder.configure(config);
        resolved = true;
        resolve(encoder);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('mp4-encoder', 'VideoEncoder configuration failed', {
          error: message,
          config,
        });

        if (!resolved) {
          resolved = true;
          reject(new Error(`VideoEncoder configuration failed: ${message}`));
        }
      }
    });
  }

  /**
   * Pick a supported avc1 codec string for the provided encode parameters.
   *
   * We use baseline-profile codec strings and skip levels that cannot possibly
   * represent the coded frame size (H.264 level limits are based on 16x16 macroblocks).
   */
  private async pickSupportedAvc1Codec(args: {
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
  }): Promise<string | null> {
    if (typeof VideoEncoder === 'undefined') {
      return null;
    }

    const { width, height, bitrate, framerate } = args;

    const alignedWidth = Math.ceil(width / 16) * 16;
    const alignedHeight = Math.ceil(height / 16) * 16;
    const codedAreaPixels = alignedWidth * alignedHeight;

    // Minimal per-level coded frame size limits (macroblocks * 256).
    // This is intentionally conservative: we only use it to skip levels that
    // are guaranteed to be too small, then we rely on isConfigSupported().
    const levelCandidates: Array<{
      levelHex: string;
      maxCodedAreaPixels: number;
    }> = [
      { levelHex: '1E', maxCodedAreaPixels: 414_720 }, // 3.0 (1620 MB)
      { levelHex: '1F', maxCodedAreaPixels: 921_600 }, // 3.1 (3600 MB)
      { levelHex: '20', maxCodedAreaPixels: 1_310_720 }, // 3.2 (5120 MB)
      { levelHex: '28', maxCodedAreaPixels: 2_097_152 }, // 4.0 (8192 MB)
      { levelHex: '29', maxCodedAreaPixels: 2_097_152 }, // 4.1 (8192 MB)
      { levelHex: '2A', maxCodedAreaPixels: 2_097_152 }, // 4.2 (8192 MB)
      { levelHex: '32', maxCodedAreaPixels: 5_652_480 }, // 5.0 (22080 MB)
      { levelHex: '33', maxCodedAreaPixels: 9_437_184 }, // 5.1 (36864 MB)
      { levelHex: '34', maxCodedAreaPixels: 14_155_776 }, // 5.2 (55296 MB)
    ];

    const prefixes = ['4200', '42E0'];
    const codecsToTry: string[] = [];

    for (const level of levelCandidates) {
      if (codedAreaPixels > level.maxCodedAreaPixels) {
        continue;
      }
      for (const prefix of prefixes) {
        codecsToTry.push(`avc1.${prefix}${level.levelHex}`);
      }
    }

    // As a final fallback, try a couple of common avc1 strings even if our
    // conservative limits table did not cover an edge case.
    codecsToTry.push('avc1.42001F');
    codecsToTry.push('avc1.42E01F');

    const base: Omit<VideoEncoderConfig, 'codec'> = {
      width,
      height,
      bitrate,
      framerate,
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' },
    };

    for (const codec of codecsToTry) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          ...base,
          codec,
        });
        if (support.supported) {
          const selectedCodec = support.config?.codec ?? codec;
          logger.debug('mp4-encoder', 'Selected H.264 codec for MP4', {
            requested: { width, height, framerate, bitrate },
            coded: { alignedWidth, alignedHeight, codedAreaPixels },
            codec: selectedCodec,
          });
          return selectedCodec;
        }
      } catch {
        // ignore and continue trying candidates
      }
    }

    logger.debug('mp4-encoder', 'No supported H.264 codec found for MP4', {
      requested: { width, height, framerate, bitrate },
      coded: { alignedWidth, alignedHeight, codedAreaPixels },
      codecsTried: codecsToTry,
    });

    return null;
  }

  /**
   * Mux encoded H.264 chunks into a real MP4 container.
   *
   * WebCodecs gives us encoded chunks, but does not provide container muxing.
   * We use Mediabunny's MP4 writer to produce a standards-compliant MP4 file.
   */
  private async muxToMp4Blob(args: {
    chunks: EncodedVideoChunk[];
    chunkMetas: Array<EncodedVideoChunkMetadata | undefined>;
    fps: number;
    shouldCancel?: () => boolean;
  }): Promise<Blob> {
    const { chunks, chunkMetas, fps, shouldCancel } = args;

    if (chunks.length === 0) {
      throw new Error('No encoded chunks available');
    }

    // Mediabunny requires a decoder config on the first packet.
    const firstMeta = chunkMetas[0];
    if (!firstMeta?.decoderConfig) {
      throw new Error('Missing decoderConfig from the first encoded chunk; cannot mux MP4');
    }

    // Lazy-load mediabunny module
    const { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } =
      await loadMediabunny();

    logger.debug('mp4-encoder', 'Muxing MP4 container (Mediabunny)', {
      chunkCount: chunks.length,
      fps,
      codec: firstMeta.decoderConfig.codec,
      codedWidth: firstMeta.decoderConfig.codedWidth,
      codedHeight: firstMeta.decoderConfig.codedHeight,
    });

    const output = new Output({
      format: new Mp4OutputFormat({
        // We already keep everything in memory, so in-memory fast-start is fine.
        fastStart: 'in-memory',
      }),
      target: new BufferTarget(),
    });

    const videoSource = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(videoSource, { frameRate: fps });

    try {
      await output.start();

      for (let i = 0; i < chunks.length; i++) {
        if (shouldCancel?.()) {
          throw new Error(ENCODING_CANCELLED_ERROR);
        }

        const chunk = chunks[i];
        if (!chunk) {
          throw new Error(`Encoded chunk ${i} is undefined`);
        }

        const packet = EncodedPacket.fromEncodedChunk(chunk);
        const meta = chunkMetas[i];

        // Pass the encoder metadata through; required for the first packet.
        await videoSource.add(packet, meta);
      }

      videoSource.close();
      await output.finalize();

      const buffer = output.target.buffer;
      if (!buffer) {
        throw new Error('MP4 output buffer not available after finalization');
      }

      return new Blob([buffer], { type: output.format.mimeType });
    } catch (error) {
      try {
        if (output.state === 'started' || output.state === 'finalizing') {
          await output.cancel();
        }
      } catch {
        // ignore cancellation errors
      }
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async dispose(): Promise<void> {
    if (this.encoder) {
      try {
        if (this.encoder.state !== 'closed') {
          this.encoder.close();
        }
      } catch (error) {
        logger.debug('mp4-encoder', 'Error closing encoder', { error });
      }
      this.encoder = null;
    }

    this.chunks = [];
    this.chunkMetas = [];

    logger.debug('mp4-encoder', 'MP4 encoder disposed');
  }
}
