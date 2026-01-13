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

import { logger } from '@utils/logger';
import type { EncoderAdapter, EncoderRequest } from '@services/encoders/encoder-interface';
import { convertFramesToImageData } from '@services/encoders/frame-converter';
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

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
  };

  private encoder: VideoEncoder | null = null;
  private chunks: EncodedVideoChunk[] = [];
  private chunkMetas: Array<EncodedVideoChunkMetadata | undefined> = [];

  /**
   * Check if MP4 encoding is available
   *
   * Requirements:
   * - VideoEncoder API support
   * - H.264 codec support (avc1.42001E - baseline profile)
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check VideoEncoder support
      if (typeof VideoEncoder === 'undefined') {
        logger.debug('mp4-encoder', 'VideoEncoder API not available');
        return false;
      }

      // Check H.264 codec support (baseline profile, level 3.0)
      const config: VideoEncoderConfig = {
        codec: 'avc1.42001E', // H.264 Baseline Profile Level 3.0
        width: 640,
        height: 480,
        bitrate: 1_000_000,
        framerate: 30,
      };

      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported) {
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
      throw new Error('No frames to encode');
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
      // Calculate bitrate based on quality and resolution
      const bitrate = this.calculateBitrate(width, height, fps, quality);

      // Configure and create encoder
      const config: VideoEncoderConfig = {
        codec: 'avc1.42001E', // H.264 Baseline Profile Level 3.0
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

      for (let i = 0; i < imageDataFrames.length; i++) {
        if (shouldCancel?.()) {
          throw new Error('Encoding cancelled');
        }

        const frame = imageDataFrames[i];
        if (!frame) {
          throw new Error(`Frame ${i} is undefined`);
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

        // Insert keyframe every 2 seconds
        const isKeyframe = i % (fps * 2) === 0;

        // Encode frame
        this.encoder.encode(videoFrame, { keyFrame: isKeyframe });
        videoFrame.close();

        encodedCount += 1;
        onProgress?.(encodedCount, frames.length);

        // Allow browser to breathe every 30 frames
        if (i % 30 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      // Flush encoder and wait for all chunks
      await this.encoder.flush();

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
    const minBitrate = 500_000;
    const maxBitrate = 20_000_000;

    return Math.max(minBitrate, Math.min(maxBitrate, Math.round(baseBitrate)));
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

          if (!resolved) {
            resolved = true;
            reject(new Error(`VideoEncoder error: ${message}`));
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
          throw new Error('Encoding cancelled');
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
