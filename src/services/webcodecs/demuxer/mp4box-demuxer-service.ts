// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

import { buildRuntimeModuleUrls, loadFromCDN } from '@utils/cdn-config';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import type {
  DemuxerAdapter,
  DemuxerMetadata,
  EncodedVideoChunk,
  VideoDecoderConfig,
} from './demuxer-adapter-service';

/**
 * MP4Box-based demuxer for MP4/MOV containers
 *
 * Extracts encoded samples directly from MP4/MOV files without HTMLVideoElement seeking.
 * Uses mp4box.js library loaded from CDN with multi-CDN fallback.
 *
 * Supported containers: MP4, MOV, M4V (ISOBMFF family)
 * Supported codecs: H.264, H.265/HEVC, AV1, VP9 (in MP4)
 */

type Mp4BoxFileInstance = object & {
  appendBuffer: (buffer: ArrayBuffer & { fileStart: number }) => void;
  flush: () => void;
  start: () => void;
  stop: () => void;
  setExtractionOptions: (trackId: number, user: unknown, options: Record<string, unknown>) => void;
  onReady?: (info: Mp4BoxInfo) => void;
  onError?: (error: Error) => void;
  onSamples?: (trackId: number, user: unknown, samples: Mp4BoxSample[]) => void;
};

type Mp4BoxInfo = {
  duration: number;
  timescale: number;
  videoTracks?: Mp4BoxTrack[];
  brands?: string[];
};

type Mp4BoxTrack = {
  id: number;
  codec: string;
  fourCC?: string;
  codec_string?: string;
  video: { width: number; height: number };
  nb_samples: number;
  movie_duration: number;
  movie_timescale: number;
  timescale: number;
  avcC?: Uint8Array | ArrayBuffer | number[];
  hvcC?: Uint8Array | ArrayBuffer | number[];
  av1C?: Uint8Array | ArrayBuffer | number[];
  vp09?: Uint8Array | ArrayBuffer | number[];
  codec_private_data?: Uint8Array | ArrayBuffer | number[];
};

type Mp4BoxSample = {
  data: ArrayBuffer | Uint8Array;
  cts: number;
  duration: number;
  is_sync: boolean;
};

type Mp4BoxModule = {
  createFile: () => Mp4BoxFileInstance;
  default?: { createFile: () => Mp4BoxFileInstance };
};

let mp4boxModulePromise: Promise<Mp4BoxModule> | null = null;

export class MP4BoxDemuxer implements DemuxerAdapter {
  private mp4boxFile: Mp4BoxFileInstance | null = null;
  private videoTrack: Mp4BoxTrack | null = null;
  private initialized = false;

  /**
   * Initialize demuxer and extract codec information from MP4/MOV file
   *
   * Parses MP4Box container structure, extracts first video track,
   * and returns decoder configuration needed for WebCodecs initialization.
   *
   * @param file - MP4/MOV file to demux
   * @returns VideoDecoderConfig with codec, dimensions, and optional description
   * @throws Error if file is invalid, no video track found, or parser timeout
   */
  async initialize(file: File): Promise<VideoDecoderConfig> {
    try {
      const Mp4Box = await this.loadMP4Box();
      this.mp4boxFile = (Mp4Box as Mp4BoxModule).createFile();

      const mp4boxFile = this.mp4boxFile;
      if (!mp4boxFile) {
        throw new Error('MP4Box file not initialized');
      }

      const infoPromise = new Promise<Mp4BoxInfo>((resolve, reject) => {
        mp4boxFile.onReady = (info: Mp4BoxInfo) => {
          logger.info('demuxer', 'MP4Box parsed container', {
            duration: info.duration,
            timescale: info.timescale,
            videoTracks: info.videoTracks?.length ?? 0,
            brands: info.brands,
          });

          const videoTrack = info.videoTracks?.[0];
          if (!videoTrack) {
            reject(new Error('No video track found in MP4'));
            return;
          }

          this.videoTrack = videoTrack;
          resolve(info);
        };

        mp4boxFile.onError = (error: Error) => {
          logger.error('demuxer', 'MP4Box error', {
            error: getErrorMessage(error),
          });
          reject(error);
        };

        setTimeout(() => {
          if (!this.videoTrack) {
            reject(new Error('MP4Box initialization timeout'));
          }
        }, 10000);
      });

      const arrayBuffer = await file.arrayBuffer();
      const bufferWithFileStart = arrayBuffer as ArrayBuffer & {
        fileStart: number;
      };
      bufferWithFileStart.fileStart = 0;

      mp4boxFile.appendBuffer(bufferWithFileStart);
      mp4boxFile.flush();

      await infoPromise;

      const videoTrack = this.videoTrack;
      if (!videoTrack) {
        throw new Error('Video track not initialized');
      }

      const config = this.extractDecoderConfig(videoTrack, arrayBuffer);
      this.initialized = true;

      logger.info('demuxer', 'MP4BoxDemuxer initialized', {
        codec: config.codec,
        width: config.codedWidth,
        height: config.codedHeight,
        hasDescription: !!config.description,
      });

      return config;
    } catch (error) {
      logger.error('demuxer', 'Failed to initialize MP4BoxDemuxer', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Extract encoded video samples for WebCodecs frame processing
   *
   * Returns an async generator that yields encoded samples for decoding.
   *
   * Note: Do not stride-skip encoded samples for inter-frame codecs (AV1/VP9/H.264/HEVC).
   * Downsample after decode by selecting decoded frames based on timestamps.
   *
   * Uses AsyncGenerator to collect all samples into a buffer before yielding them\n   * one at a time. This allows the generator to provide consistent, ordered output\n   * while still exposing an AsyncGenerator interface. Note: buffering all samples\n   * in memory may exhaust resources on very large files; consider chunked extraction\n   * for files with high sample counts.
   *
   * @param targetFps - Target frames per second for sampling
   * @param maxFrames - Optional maximum frame count to extract
   * @returns AsyncGenerator yielding encoded video chunks (key and delta frames)
   * @throws Error if demuxer not initialized or sample extraction fails
   */
  async *extractSamples(
    targetFps: number,
    maxFrames?: number
  ): AsyncGenerator<EncodedVideoChunk, void, unknown> {
    if (!this.initialized || !this.videoTrack) {
      throw new Error('Demuxer not initialized');
    }

    try {
      const sampleQueue: Mp4BoxSample[] = [];
      let samplesReceived = false;
      const mp4boxFile = this.mp4boxFile;
      const videoTrack = this.videoTrack;

      // Derive a time cap from the requested output budget.
      // We still need to decode all samples within this window to preserve
      // reference chains, but we can stop yielding samples after the window.
      const maxDurationSeconds = maxFrames ? maxFrames / targetFps : undefined;
      const maxDurationMicros = maxDurationSeconds
        ? Math.round(maxDurationSeconds * 1_000_000)
        : undefined;
      const durationSlackMicros = Math.round(1_000_000); // 1s slack for rounding/edits

      if (!mp4boxFile || !videoTrack) {
        throw new Error('Demuxer not initialized');
      }

      const extractionStartedAtMs = performance.now();
      let firstSamplesAtMs: number | null = null;

      const samplePromise = new Promise<void>((resolve, reject) => {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const clearIdle = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
        };

        const timeoutTimer = setTimeout(() => {
          clearIdle();
          if (!samplesReceived) {
            reject(new Error('Sample extraction timeout'));
          } else {
            // We got some samples but mp4box didn't call again; proceed with what we have.
            resolve();
          }
        }, 60000);

        const settleIfComplete = () => {
          // Resolve when we have all samples, otherwise resolve after a short idle period.
          if (videoTrack.nb_samples > 0 && sampleQueue.length >= videoTrack.nb_samples) {
            clearIdle();
            clearTimeout(timeoutTimer);
            resolve();
            return;
          }

          clearIdle();
          idleTimer = setTimeout(() => {
            clearTimeout(timeoutTimer);
            resolve();
          }, 250);
        };

        mp4boxFile.onSamples = (trackId: number, _user: unknown, samples: Mp4BoxSample[]) => {
          logger.info('demuxer', 'Received samples from MP4Box', {
            trackId,
            sampleCount: samples.length,
          });

          if (firstSamplesAtMs === null) {
            firstSamplesAtMs = performance.now();
            logger.debug('demuxer', 'First MP4Box samples received', {
              trackId,
              firstBatchSamples: samples.length,
              waitMs: firstSamplesAtMs - extractionStartedAtMs,
            });
          }

          sampleQueue.push(...samples);
          samplesReceived = true;
          settleIfComplete();
        };
      });

      mp4boxFile.setExtractionOptions(videoTrack.id, null, {
        // mp4box's nbSamples is the batch size per callback.
        nbSamples: 1024,
        // Align extraction to random access points when possible to avoid
        // starting a decode from a non-keyframe.
        rapAlignment: true,
      });

      mp4boxFile.start();
      await samplePromise;
      mp4boxFile.stop();

      logger.debug('demuxer', 'MP4Box sample queue ready', {
        queuedSamples: sampleQueue.length,
        expectedSamples: videoTrack.nb_samples,
        waitMs: performance.now() - extractionStartedAtMs,
        firstSamplesWaitMs: firstSamplesAtMs ? firstSamplesAtMs - extractionStartedAtMs : null,
      });

      const sourceFps =
        videoTrack.nb_samples / (videoTrack.movie_duration / videoTrack.movie_timescale);

      logger.info('demuxer', 'Extracting samples', {
        totalSamples: sampleQueue.length,
        sourceFps: sourceFps.toFixed(2),
        targetFps,
        maxDurationSeconds: maxDurationSeconds?.toFixed(3) ?? 'full',
      });

      let yieldedSamples = 0;
      let keySamples = 0;
      let deltaSamples = 0;
      const firstSample = sampleQueue[0];
      const baseTimestampMicros = firstSample
        ? Math.round((firstSample.cts / videoTrack.timescale) * 1_000_000)
        : 0;
      let lastTimestampMicros = baseTimestampMicros;

      for (let i = 0; i < sampleQueue.length; i += 1) {
        const sample = sampleQueue[i];
        if (!sample) {
          break;
        }

        const timestampMicros = Math.round((sample.cts / videoTrack.timescale) * 1_000_000);
        const durationMicros = Math.round((sample.duration / videoTrack.timescale) * 1_000_000);
        lastTimestampMicros = timestampMicros;

        if (
          maxDurationMicros !== undefined &&
          timestampMicros > baseTimestampMicros + maxDurationMicros + durationSlackMicros
        ) {
          break;
        }

        yield {
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: timestampMicros,
          duration: durationMicros,
          data: new Uint8Array(sample.data),
        };

        yieldedSamples++;
        if (sample.is_sync) {
          keySamples += 1;
        } else {
          deltaSamples += 1;
        }
      }

      logger.info('demuxer', 'Sample extraction completed', {
        yieldedSamples,
      });

      logger.debug('demuxer', 'MP4Box sample extraction stats', {
        yieldedSamples,
        keySamples,
        deltaSamples,
        baseTimestampMicros,
        lastTimestampMicros,
        durationMicros: Math.max(0, lastTimestampMicros - baseTimestampMicros),
      });
    } catch (error) {
      logger.error('demuxer', 'Sample extraction failed', {
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve video metadata (duration, framerate, sample count)
   *
   * Must be called after initialize(). Returns metadata extracted
   * during container parsing.
   *
   * @returns DemuxerMetadata with duration, framerate, sample count
   * @throws Error if demuxer not initialized
   */
  getMetadata(): DemuxerMetadata {
    if (!this.initialized || !this.videoTrack) {
      throw new Error('Demuxer not initialized');
    }

    const duration = this.videoTrack.movie_duration / this.videoTrack.movie_timescale;
    const framerate =
      this.videoTrack.nb_samples /
      (this.videoTrack.movie_duration / this.videoTrack.movie_timescale);

    return {
      duration,
      framerate,
      sampleCount: this.videoTrack.nb_samples,
    };
  }

  /**
   * Clean up demuxer resources and release references
   *
   * Should be called when demuxer is no longer needed. Stops MP4Box parsing,
   * flushes internal buffers, and clears state.
   */
  destroy(): void {
    if (this.mp4boxFile) {
      try {
        const mp4boxFile = this.mp4boxFile;
        mp4boxFile.stop();
        mp4boxFile.flush();
      } catch (error) {
        logger.warn('demuxer', 'Error during MP4Box cleanup', {
          error: getErrorMessage(error),
        });
      }
      this.mp4boxFile = null;
    }
    this.videoTrack = null;
    this.initialized = false;
  }

  /**
   * Extract VideoDecoder configuration from MP4Box track information
   *
   * Combines codec string and initialization data to create a configuration
   * object compatible with WebCodecs VideoDecoder.
   *
   * @param track - MP4Box track containing codec and video properties
   * @returns VideoDecoderConfig with codec, dimensions, and optional description
   * @internal Private method, use initialize() instead
   */
  private extractDecoderConfig(track: Mp4BoxTrack, fileBytes?: ArrayBuffer): VideoDecoderConfig {
    const codec = this.buildCodecString(track);
    const description = this.extractCodecDescription(track, fileBytes);

    return {
      codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      description,
    };
  }

  /**
   * Build full codec string from MP4Box track information
   *
   * Attempts to construct detailed codec string with profile/level information.
   * Examples: 'avc1.64001f' (H.264 High@L3.1), 'hvc1.1.6.L93.B0' (HEVC)
   *
   * Resolution order:
   * 1. MP4Box-provided codec_string (most reliable)
   * 2. MP4Box-provided codec / FourCC (already contains profile/level when numeric)
   * 3. Parse avcC/hvcC box to extract profile_idc / constraint / level_idc
   *
   * @param track - MP4Box track with codec information
   * @returns Codec string suitable for WebCodecs VideoDecoder
   * @throws Error if codec string cannot be determined
   * @internal Private method
   */
  private buildCodecString(track: Mp4BoxTrack): string {
    // 1. MP4Box codec_string — already a complete RFC 6381 string
    if (track.codec_string) {
      return track.codec_string;
    }

    // 2. MP4Box codec / FourCC — often already contains profile/level info
    //    e.g., "avc1.640032" is a valid RFC 6381 codec string
    const mp4boxCodec = track.codec || track.fourCC;
    if (mp4boxCodec && this.looksLikeRfc6381Codec(mp4boxCodec)) {
      logger.info('demuxer', 'Using MP4Box codec as RFC 6381 string', {
        codec: mp4boxCodec,
      });
      return mp4boxCodec;
    }

    // 3. Parse avcC / hvcC box to build codec string from binary data
    const parsed = this.parseCodecFromBox(track);
    if (parsed) {
      logger.info('demuxer', 'Built codec string from codec box', {
        codec: parsed,
        source: track.avcC ? 'avcC' : 'hvcC',
      });
      return parsed;
    }

    // 4. Raw FourCC fallback (least preferred — may cause VideoDecoder issues)
    if (mp4boxCodec) {
      logger.warn('demuxer', 'Using raw FourCC as codec string', {
        fourCC: mp4boxCodec,
        message:
          'Unable to determine detailed codec string from track or codec boxes — may cause VideoDecoder issues',
      });
      return mp4boxCodec;
    }

    throw new Error('Unable to determine codec string from track');
  }

  /**
   * Check whether a codec string already looks like a valid RFC 6381 identifier.
   *
   * Valid patterns: avc1.XXYYZZ, avc3.XXYYZZ, av01.X.X.M.X, vp09.XX.XX.XX,
   *                hvc1.X.XX.XXX.XX, hev1.X.XX.XXX.XX, vp08.XX.XX.XX
   */
  private looksLikeRfc6381Codec(codec: string): boolean {
    return /^(avc1|avc3|av01|vp09|vp08|hvc1|hev1)(\.|$)/.test(codec);
  }

  /**
   * Build codec string from raw codec configuration box data.
   *
   * - H.264 avcC: [version(1) | profile(1) | constraints(1) | level(1) | ...]
   *   → avc1.PPCCLL  (hex values, 2 digits each)
   * - HEVC hvcC:  [version(1) | general_profile_space(2bits) | ...]
   *   → hvc1.1.6.L93.B0 format
   *
   * @param track - MP4Box track with codec box data
   * @returns Codec string or undefined if parsing failed
   */
  private parseCodecFromBox(track: Mp4BoxTrack): string | undefined {
    // H.264: avcC box
    // Layout: [version(1) | profile_idc(1) | constraint_flags(1) | level_idc(1) | ...]
    if (track.avcC) {
      const avcCData = this.toUint8Array(track.avcC);
      if (avcCData && avcCData.length >= 4) {
        const p = avcCData[1]!;
        const c = avcCData[2]!;
        const l = avcCData[3]!;
        return `avc1.${p.toString(16).padStart(2, '0').toLowerCase()}${c.toString(16).padStart(2, '0').toLowerCase()}${l.toString(16).padStart(2, '0').toLowerCase()}`;
      }
    }

    // HEVC: hvcC box
    // Layout: [version(1) | general_profile_space+flags(1) | general_profile_idc(5bits from byte1+3bits from byte2) |
    //          general_profile_compatibility_flags(4) | general_constraint_indicator_flags(4) |
    //          general_level_idc(1) | ...]
    if (track.hvcC) {
      const hvcCData = this.toUint8Array(track.hvcC);
      if (hvcCData && hvcCData.length >= 13) {
        const profileIdc = (hvcCData[1]! & 0x1f) | ((hvcCData[2]! & 0x07) << 3);
        const constraintFlags =
          (hvcCData[6]! << 24) | (hvcCData[7]! << 16) | (hvcCData[8]! << 8) | hvcCData[9]!;
        const levelIdc = hvcCData[12]!;
        const constraintHex = constraintFlags.toString(16).padStart(8, '0').toLowerCase();
        return `hvc1.${profileIdc}.${constraintHex.slice(0, 2)}.L${levelIdc}.${constraintHex.slice(4).toUpperCase()}0`;
      }
    }

    return undefined;
  }

  /**
   * Normalize codec box data to Uint8Array.
   */
  private toUint8Array(data: Uint8Array | ArrayBuffer | number[]): Uint8Array | undefined {
    if (!data) return undefined;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    return undefined;
  }

  /**
   * Extract codec-specific initialization data (EXTRADATA)
   *
   * Locates and extracts the codec description box needed for WebCodecs:
   * - H.264: avcC box (SPS/PPS sequences)
   * - HEVC: hvcC box
   * - AV1: av1C box
   * - VP9: vp09 box (optional)
   *
   * Handles multiple source formats (Uint8Array, ArrayBuffer, number[]).
   *
   * @param track - MP4Box track with codec boxes
   * @returns Codec description data, or undefined if not found
   * @internal Private method
   */
  /**
   * Attempt to locate a codec configuration box payload directly from MP4 bytes.
   *
   * This is primarily needed for AV1 MP4 where mp4box (pinned in package.json)
   * may not surface av1C on the track object, yet WebCodecs VideoDecoder requires it.
   */
  private findIsobmffBoxPayload(
    fileBytes: ArrayBuffer,
    boxType: string,
    maxBoxSizeBytes: number = 4096
  ): Uint8Array | undefined {
    const u8 = new Uint8Array(fileBytes);
    const view = new DataView(fileBytes);

    if (boxType.length !== 4) {
      return undefined;
    }

    const t0 = boxType.charCodeAt(0);
    const t1 = boxType.charCodeAt(1);
    const t2 = boxType.charCodeAt(2);
    const t3 = boxType.charCodeAt(3);

    let bestPayload: Uint8Array | undefined;

    // Scan for [size][type] patterns. We validate size bounds to reduce false positives.
    for (let i = 0; i <= u8.length - 8; i += 1) {
      if (u8[i + 4] !== t0 || u8[i + 5] !== t1 || u8[i + 6] !== t2 || u8[i + 7] !== t3) {
        continue;
      }

      const size32 = view.getUint32(i, false);
      let headerSize = 8;
      let boxSize = size32;
      let payloadStart = i + 8;

      if (size32 === 1) {
        // 64-bit largesize
        if (typeof view.getBigUint64 !== 'function') {
          continue;
        }
        if (i + 16 > u8.length) {
          continue;
        }
        const largeSize = Number(view.getBigUint64(i + 8, false));
        if (!Number.isFinite(largeSize)) {
          continue;
        }
        headerSize = 16;
        boxSize = largeSize;
        payloadStart = i + 16;
      }

      // Basic sanity checks
      if (!Number.isFinite(boxSize) || boxSize < headerSize) {
        continue;
      }

      const payloadLen = boxSize - headerSize;
      if (payloadLen <= 0) {
        continue;
      }

      // Config boxes are expected to be small.
      if (payloadLen > maxBoxSizeBytes) {
        continue;
      }

      const payloadEnd = payloadStart + payloadLen;
      if (payloadStart < 0 || payloadEnd > u8.length) {
        continue;
      }

      const payload = u8.slice(payloadStart, payloadEnd);
      if (!bestPayload || payload.byteLength < bestPayload.byteLength) {
        bestPayload = payload;
        // Early exit for very small payloads (typical for av1C/hvcC/avcC)
        if (bestPayload.byteLength <= 32) {
          break;
        }
      }
    }

    return bestPayload;
  }

  private extractCodecDescription(
    track: Mp4BoxTrack,
    fileBytes?: ArrayBuffer
  ): Uint8Array | undefined {
    const descriptionSources = [
      track.avcC,
      track.hvcC,
      track.av1C,
      track.vp09,
      track.codec_private_data,
    ];

    for (const source of descriptionSources) {
      if (source) {
        if (source instanceof Uint8Array) {
          return source;
        }
        if (source instanceof ArrayBuffer) {
          return new Uint8Array(source);
        }
        if (Array.isArray(source)) {
          return new Uint8Array(source);
        }
      }
    }

    const codecHint = (track.codec_string || track.codec || track.fourCC || '').toLowerCase();

    if (fileBytes) {
      const candidateBoxes: string[] = [];

      if (codecHint.includes('av01') || codecHint.includes('av1')) {
        candidateBoxes.push('av1C');
      }
      if (codecHint.includes('hvc1') || codecHint.includes('hev1') || codecHint.includes('hevc')) {
        candidateBoxes.push('hvcC');
      }
      if (codecHint.includes('avc1') || codecHint.includes('avc') || codecHint.includes('h264')) {
        candidateBoxes.push('avcC');
      }
      if (codecHint.includes('vp09') || codecHint.includes('vp9')) {
        // ISO-BMFF VP9 config record box
        candidateBoxes.push('vpcC');
      }

      for (const boxType of candidateBoxes) {
        const payload = this.findIsobmffBoxPayload(fileBytes, boxType);
        if (payload && payload.byteLength > 0) {
          logger.info('demuxer', 'Extracted codec description from MP4 bytes', {
            codec: track.codec || track.fourCC,
            boxType,
            byteLength: payload.byteLength,
          });
          return payload;
        }
      }
    }

    logger.warn('demuxer', 'No codec description found', {
      codec: track.codec || track.fourCC,
      message: 'VideoDecoder may fail without codec-specific initialization data',
    });

    return undefined;
  }

  /**
   * Load mp4box.js library from CDN with multi-CDN fallback
   *
   * Attempts to load mp4box.js from multiple CDN sources (esm.sh, jsdelivr, unpkg)
   * with automatic fallback. Uses loadFromCDN utility for robust loading with
   * timeout protection and detailed logging.
   *
   * @returns MP4BoxModule with createFile() factory function
   * @throws Error if all CDN sources fail
   * @internal Private method, called during initialize()
   */
  private async loadMP4Box(): Promise<Mp4BoxModule> {
    if (!mp4boxModulePromise) {
      mp4boxModulePromise = loadFromCDN<Mp4BoxModule>(
        'mp4box.js',
        buildRuntimeModuleUrls('mp4box')
      );
    }

    return mp4boxModulePromise.catch((error) => {
      // Allow retry on subsequent attempts if CDN loading failed.
      mp4boxModulePromise = null;
      throw error;
    });
  }
}
