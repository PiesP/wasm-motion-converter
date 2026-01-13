/**
 * Hybrid Path Benchmark Harness (Dev Only)
 *
 * Benchmarks the optional "hybrid" pipeline: WebCodecs decode + FFmpeg encode.
 * Compares against existing paths:
 * - cpu: FFmpeg direct (transcode)
 * - gpu: WebCodecs conversion service (may fall back internally)
 *
 * This module is intentionally dev-only and does not modify production routing.
 */

import type { ConversionOptions, ConversionOutputBlob, VideoMetadata } from '@t/conversion-types';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

import { pickVideoFile } from '@services/dev/mp4-smoke-test';
import { ffmpegService } from '@services/ffmpeg-service';
import { analyzeVideo, analyzeVideoQuick } from '@services/video-analyzer-service';
import { webcodecsConversionService } from '@services/webcodecs-conversion-service';
import {
  WebCodecsDecoderService,
  type WebCodecsCaptureMode,
  type WebCodecsFrameFormat,
} from '@services/webcodecs-decoder-service';
import { computeExpectedFramesFromDuration } from '@services/webcodecs/conversion/frame-requirements';
import { resolveAnimationDurationSeconds, resolveWebPFps } from '@services/webcodecs/webp-timing';

export type BenchmarkPath = 'cpu' | 'gpu' | 'hybrid';
export type BenchmarkFormat = 'gif' | 'webp';

export type BenchmarkRunResult = {
  path: BenchmarkPath;
  format: BenchmarkFormat;
  durationMs: number;
  outputBytes: number;
  captureModeUsed?: WebCodecsCaptureMode;
  encoderBackendUsed?: string;
  jsHeapPeakBytes?: number;
  jsHeapStartBytes?: number;
  jsHeapEndBytes?: number;
};

export type BenchmarkScenarioSummary = {
  path: BenchmarkPath;
  format: BenchmarkFormat;
  runs: BenchmarkRunResult[];
  stats: {
    medianMs: number;
    meanMs: number;
    minMs: number;
    maxMs: number;
  };
  memory?: {
    peakMedianBytes?: number;
  };
};

export type HybridBenchmarkResult = {
  file: {
    name: string;
    sizeBytes: number;
    type: string;
  };
  metadata: VideoMetadata;
  params: {
    outputs: BenchmarkFormat[];
    paths: BenchmarkPath[];
    warmupRuns: number;
    runs: number;
    targetFps: number;
    options: ConversionOptions;
  };
  results: BenchmarkScenarioSummary[];
};

type JsHeapSnapshot = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

function readJsHeapSnapshot(): JsHeapSnapshot | null {
  const perf = performance as unknown as { memory?: Partial<JsHeapSnapshot> };
  const mem = perf?.memory;
  if (!mem) {
    return null;
  }

  if (
    typeof mem.usedJSHeapSize !== 'number' ||
    typeof mem.totalJSHeapSize !== 'number' ||
    typeof mem.jsHeapSizeLimit !== 'number'
  ) {
    return null;
  }

  return {
    usedJSHeapSize: mem.usedJSHeapSize,
    totalJSHeapSize: mem.totalJSHeapSize,
    jsHeapSizeLimit: mem.jsHeapSizeLimit,
  };
}

function createJsHeapPeakSampler(intervalMs = 200) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let peakBytes: number | null = null;
  let startBytes: number | null = null;
  let endBytes: number | null = null;

  const sample = () => {
    const snap = readJsHeapSnapshot();
    if (!snap) {
      return;
    }
    const used = snap.usedJSHeapSize;
    if (startBytes === null) {
      startBytes = used;
    }
    endBytes = used;
    peakBytes = peakBytes === null ? used : Math.max(peakBytes, used);
  };

  return {
    start: () => {
      sample();
      timer = setInterval(sample, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      sample();
    },
    snapshot: () => ({
      peakBytes: peakBytes ?? undefined,
      startBytes: startBytes ?? undefined,
      endBytes: endBytes ?? undefined,
    }),
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[mid - 1] ?? 0;
    const upper = sorted[mid] ?? lower;
    return (lower + upper) / 2;
  }
  return sorted[mid] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarizeRuns(runs: BenchmarkRunResult[]): BenchmarkScenarioSummary {
  const durations = runs.map((r) => r.durationMs);
  const peaks = runs
    .map((r) => r.jsHeapPeakBytes)
    .filter((v): v is number => typeof v === 'number');

  return {
    path: runs[0]?.path ?? 'cpu',
    format: runs[0]?.format ?? 'gif',
    runs,
    stats: {
      medianMs: median(durations),
      meanMs: mean(durations),
      minMs: durations.length ? Math.min(...durations) : 0,
      maxMs: durations.length ? Math.max(...durations) : 0,
    },
    memory: peaks.length ? { peakMedianBytes: median(peaks) } : undefined,
  };
}

async function ensureDevOnly(): Promise<void> {
  if (!import.meta.env.DEV) {
    throw new Error('Hybrid benchmark is dev-only.');
  }
  if (typeof performance === 'undefined') {
    throw new Error('Hybrid benchmark requires performance.now().');
  }
}

async function resolveMetadata(file: File): Promise<VideoMetadata> {
  try {
    const quick = await analyzeVideoQuick(file);
    // codec is unknown here; use it only as a fast duration sanity check.
    if (quick.width > 0 && quick.height > 0 && quick.duration > 0) {
      logger.debug('general', 'Quick metadata', quick);
    }
  } catch (error) {
    logger.debug('general', 'Quick metadata failed (non-critical)', {
      error: getErrorMessage(error),
    });
  }

  // For benchmark routing signals (WebCodecs eligibility), we need the codec.
  return analyzeVideo(file);
}

async function convertCpu(params: {
  file: File;
  format: BenchmarkFormat;
  options: ConversionOptions;
  metadata: VideoMetadata;
}): Promise<ConversionOutputBlob> {
  const { file, format, options, metadata } = params;
  const blob =
    format === 'gif'
      ? await ffmpegService.convertToGIF(file, options, metadata)
      : await ffmpegService.convertToWebP(file, options, metadata);
  const out = blob as ConversionOutputBlob;
  out.encoderBackendUsed = out.encoderBackendUsed ?? 'ffmpeg';
  return out;
}

async function convertGpu(params: {
  file: File;
  format: BenchmarkFormat;
  options: ConversionOptions;
  metadata: VideoMetadata;
}): Promise<ConversionOutputBlob> {
  const { file, format, options, metadata } = params;
  const blob = await webcodecsConversionService.maybeConvert(file, format, options, metadata);
  if (!blob) {
    throw new Error('GPU path is not available for this input (maybeConvert returned null).');
  }
  return blob;
}

async function convertHybrid(params: {
  file: File;
  format: BenchmarkFormat;
  options: ConversionOptions;
  metadata: VideoMetadata;
  targetFps: number;
  scale: number;
  captureMode?: WebCodecsCaptureMode;
  maxFrames?: number;
}): Promise<ConversionOutputBlob> {
  const { file, format, options, metadata, targetFps, scale, captureMode, maxFrames } = params;

  if (!ffmpegService.isLoaded()) {
    await ffmpegService.initialize();
  }

  const decoder = new WebCodecsDecoderService();
  const frameFiles: string[] = [];
  const frameTimestamps: number[] = [];

  let lastValidFrame: Uint8Array | null = null;
  let decodeResult: Awaited<ReturnType<WebCodecsDecoderService['decodeToFrames']>>;

  try {
    decodeResult = await decoder.decodeToFrames({
      file,
      targetFps,
      scale,
      maxFrames,
      frameFormat: FFMPEG_INTERNALS.WEBCODECS.FRAME_FORMAT as WebCodecsFrameFormat,
      frameQuality: FFMPEG_INTERNALS.WEBCODECS.FRAME_QUALITY,
      framePrefix: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_PREFIX,
      frameDigits: FFMPEG_INTERNALS.WEBCODECS.FRAME_FILE_DIGITS,
      frameStartNumber: FFMPEG_INTERNALS.WEBCODECS.FRAME_START_NUMBER,
      captureMode: captureMode ?? 'auto',
      codec: metadata.codec,
      quality: options.quality,
      onProgress: undefined,
      shouldCancel: undefined,
      onFrame: async (frame) => {
        if (!frame.data || frame.data.byteLength === 0) {
          if (!lastValidFrame) {
            throw new Error('WebCodecs did not provide encoded frame data.');
          }
          await ffmpegService.writeVirtualFile(frame.name, new Uint8Array(lastValidFrame));
          frameFiles.push(frame.name);
          frameTimestamps.push(frame.timestamp);
          return;
        }

        const encoded = new Uint8Array(frame.data);
        lastValidFrame = encoded;
        await ffmpegService.writeVirtualFile(frame.name, encoded);
        frameFiles.push(frame.name);
        frameTimestamps.push(frame.timestamp);
      },
    });

    const expectedFrames = computeExpectedFramesFromDuration({
      durationSeconds: decodeResult.duration,
      fps: targetFps,
    });

    if (decodeResult.frameCount === 0) {
      throw new Error('Hybrid decode produced zero frames.');
    }

    const captureRatio = decodeResult.frameCount / Math.max(1, expectedFrames);
    if (decodeResult.frameCount < 10 || captureRatio < 0.5) {
      throw new Error(
        `Hybrid capture incomplete: captured ${decodeResult.frameCount} of ${expectedFrames} frames ` +
          `(${(captureRatio * 100).toFixed(1)}%).`
      );
    }

    const durationSeconds = resolveAnimationDurationSeconds(
      decodeResult.frameCount,
      targetFps,
      metadata,
      decodeResult.duration
    );

    const fpsForEncoding =
      format === 'webp'
        ? resolveWebPFps(decodeResult.frameCount, targetFps, durationSeconds)
        : targetFps;

    if (format === 'webp' && fpsForEncoding !== targetFps) {
      logger.info('performance', 'Adjusted hybrid WebP FPS to preserve pacing', {
        targetFps,
        adjustedFps: fpsForEncoding,
        frameCount: decodeResult.frameCount,
        durationSeconds: durationSeconds ?? decodeResult.duration,
      });
    }

    const blob = await ffmpegService.encodeFrameSequence({
      format,
      options,
      frameCount: decodeResult.frameCount,
      fps: fpsForEncoding,
      durationSeconds: durationSeconds ?? metadata.duration ?? decodeResult.duration,
      frameFiles,
      // Provide timestamps when available (best-effort). FFmpegEncoder may ignore them.
      frameTimestamps: format === 'webp' ? frameTimestamps : undefined,
    });

    const out = blob as ConversionOutputBlob;
    out.captureModeUsed = decodeResult.captureModeUsed;
    out.encoderBackendUsed = out.encoderBackendUsed ?? 'ffmpeg';
    return out;
  } catch (error) {
    // Best-effort cleanup. encodeFrameSequence typically cleans up, but this covers early failures.
    try {
      if (frameFiles.length > 0) {
        await ffmpegService.deleteVirtualFiles(frameFiles);
      }
    } catch (cleanupError) {
      logger.debug('general', 'Hybrid cleanup failed (non-critical)', {
        error: getErrorMessage(cleanupError),
      });
    }
    throw error;
  }
}

async function runOne(params: {
  path: BenchmarkPath;
  format: BenchmarkFormat;
  file: File;
  metadata: VideoMetadata;
  options: ConversionOptions;
  targetFps: number;
  hybridConfig?: {
    scale: number;
    captureMode?: WebCodecsCaptureMode;
    maxFrames?: number;
  };
}): Promise<BenchmarkRunResult> {
  const { path, format, file, metadata, options, targetFps } = params;
  const sampler = createJsHeapPeakSampler(200);

  const before = readJsHeapSnapshot()?.usedJSHeapSize;
  sampler.start();
  const t0 = performance.now();

  let blob: ConversionOutputBlob;
  let t1 = t0;
  let after = before;
  let snap: ReturnType<typeof sampler.snapshot> | null = null;

  try {
    if (path === 'cpu') {
      blob = await convertCpu({ file, format, options, metadata });
    } else if (path === 'gpu') {
      blob = await convertGpu({ file, format, options, metadata });
    } else {
      const scale = params.hybridConfig?.scale ?? options.scale;
      blob = await convertHybrid({
        file,
        format,
        options,
        metadata,
        targetFps,
        scale,
        captureMode: params.hybridConfig?.captureMode,
        maxFrames: params.hybridConfig?.maxFrames,
      });
    }
  } finally {
    t1 = performance.now();
    sampler.stop();
    after = readJsHeapSnapshot()?.usedJSHeapSize;
    snap = sampler.snapshot();
  }

  return {
    path,
    format,
    durationMs: Math.max(0, t1 - t0),
    outputBytes: blob.size,
    captureModeUsed: (blob as ConversionOutputBlob).captureModeUsed as
      | WebCodecsCaptureMode
      | undefined,
    encoderBackendUsed: (blob as ConversionOutputBlob).encoderBackendUsed,
    jsHeapPeakBytes: snap?.peakBytes,
    jsHeapStartBytes: before,
    jsHeapEndBytes: after,
  };
}

export async function runHybridBenchmark(params?: {
  /** If omitted, a file picker is shown. */
  file?: File;
  /** Output formats to benchmark. Defaults to ['gif','webp']. */
  outputs?: BenchmarkFormat[];
  /** Paths to benchmark. Defaults to ['cpu','gpu','hybrid']. */
  paths?: BenchmarkPath[];
  /** Number of warm-up runs per (path, format). Defaults to 1. */
  warmupRuns?: number;
  /** Number of measured runs per (path, format). Defaults to 3. */
  runs?: number;
  /** Target FPS for hybrid capture and as a shared benchmark setting. Defaults to 15. */
  targetFps?: number;
  /** Conversion options (quality + scale). Defaults to { quality: 'low', scale: 1.0 }. */
  options?: ConversionOptions;

  /** Hybrid-only decode parameters (best-effort). */
  hybrid?: {
    captureMode?: WebCodecsCaptureMode;
    maxFrames?: number;
  };
}): Promise<HybridBenchmarkResult> {
  await ensureDevOnly();

  const file = params?.file ?? (await pickVideoFile('video/*'));
  const outputs: BenchmarkFormat[] = params?.outputs?.length ? params.outputs : ['gif', 'webp'];
  const paths: BenchmarkPath[] = params?.paths?.length ? params.paths : ['cpu', 'gpu', 'hybrid'];

  const warmupRuns = Math.max(0, Math.floor(params?.warmupRuns ?? 1));
  const runs = Math.max(1, Math.floor(params?.runs ?? 3));

  const targetFps = Math.max(1, Math.floor(params?.targetFps ?? 15));
  const options: ConversionOptions = params?.options ?? {
    quality: 'low',
    scale: 1.0,
  };

  logger.info('performance', 'Starting hybrid benchmark', {
    fileName: file.name,
    fileSizeBytes: file.size,
    fileType: file.type,
    outputs,
    paths,
    warmupRuns,
    runs,
    targetFps,
    quality: options.quality,
    scale: options.scale,
    jsHeapSampling: Boolean(readJsHeapSnapshot()),
  });

  const metadata = await resolveMetadata(file);

  if (!ffmpegService.isLoaded()) {
    // Ensure consistent first-run behavior across paths.
    await ffmpegService.initialize();
  }

  const scenarioSummaries: BenchmarkScenarioSummary[] = [];

  for (const format of outputs) {
    for (const path of paths) {
      // Warm-up
      for (let i = 0; i < warmupRuns; i++) {
        try {
          await runOne({
            path,
            format,
            file,
            metadata,
            options,
            targetFps,
            hybridConfig: {
              scale: options.scale,
              captureMode: params?.hybrid?.captureMode,
              maxFrames: params?.hybrid?.maxFrames,
            },
          });
        } catch (error) {
          logger.warn('general', 'Warm-up run failed', {
            path,
            format,
            error: getErrorMessage(error),
          });
          break;
        }
      }

      const measured: BenchmarkRunResult[] = [];
      for (let i = 0; i < runs; i++) {
        const result = await runOne({
          path,
          format,
          file,
          metadata,
          options,
          targetFps,
          hybridConfig: {
            scale: options.scale,
            captureMode: params?.hybrid?.captureMode,
            maxFrames: params?.hybrid?.maxFrames,
          },
        });
        measured.push(result);

        logger.info('performance', 'Benchmark run completed', {
          path,
          format,
          run: i + 1,
          durationMs: Math.round(result.durationMs),
          outputBytes: result.outputBytes,
          encoderBackendUsed: result.encoderBackendUsed ?? null,
          captureModeUsed: result.captureModeUsed ?? null,
          jsHeapPeakBytes: result.jsHeapPeakBytes ?? null,
        });
      }

      const summary = summarizeRuns(measured);
      scenarioSummaries.push(summary);

      logger.info('performance', 'Benchmark scenario summary', {
        path,
        format,
        medianMs: Math.round(summary.stats.medianMs),
        meanMs: Math.round(summary.stats.meanMs),
        minMs: Math.round(summary.stats.minMs),
        maxMs: Math.round(summary.stats.maxMs),
        peakMedianBytes: summary.memory?.peakMedianBytes ?? null,
      });
    }
  }

  const result: HybridBenchmarkResult = {
    file: {
      name: file.name,
      sizeBytes: file.size,
      type: file.type,
    },
    metadata,
    params: {
      outputs,
      paths,
      warmupRuns,
      runs,
      targetFps,
      options,
    },
    results: scenarioSummaries,
  };

  logger.info('performance', 'Hybrid benchmark completed', {
    codec: metadata.codec,
    durationSeconds: metadata.duration,
    results: scenarioSummaries.map((s) => ({
      path: s.path,
      format: s.format,
      medianMs: Math.round(s.stats.medianMs),
    })),
  });

  return result;
}

export async function runHybridAcceptanceGateSuite(params?: {
  /** Prompt for each file if not provided. */
  h264Mp4?: File;
  vp9Webm?: File;
  av1File?: File;
  /** Shared benchmark settings. */
  options?: ConversionOptions;
  targetFps?: number;
  warmupRuns?: number;
  runs?: number;
}): Promise<{
  h264: HybridBenchmarkResult;
  vp9: HybridBenchmarkResult;
  av1: HybridBenchmarkResult;
}> {
  await ensureDevOnly();

  const options = params?.options ?? { quality: 'low', scale: 1.0 };
  const targetFps = params?.targetFps ?? 15;
  const warmupRuns = params?.warmupRuns ?? 1;
  const runs = params?.runs ?? 3;

  const h264Mp4 = params?.h264Mp4 ?? (await pickVideoFile('video/mp4'));
  const vp9Webm = params?.vp9Webm ?? (await pickVideoFile('video/webm'));
  const av1File = params?.av1File ?? (await pickVideoFile('video/*'));

  const h264 = await runHybridBenchmark({
    file: h264Mp4,
    outputs: ['gif', 'webp'],
    paths: ['cpu', 'gpu', 'hybrid'],
    options,
    targetFps,
    warmupRuns,
    runs,
  });

  const vp9 = await runHybridBenchmark({
    file: vp9Webm,
    outputs: ['gif', 'webp'],
    paths: ['cpu', 'gpu', 'hybrid'],
    options,
    targetFps,
    warmupRuns,
    runs,
  });

  const av1 = await runHybridBenchmark({
    file: av1File,
    outputs: ['gif', 'webp'],
    paths: ['cpu', 'gpu', 'hybrid'],
    options,
    targetFps,
    warmupRuns,
    runs,
  });

  return { h264, vp9, av1 };
}
