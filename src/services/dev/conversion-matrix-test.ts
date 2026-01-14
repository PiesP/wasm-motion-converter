import type { ConversionFormat, ConversionOptions, VideoMetadata } from '@t/conversion-types';
import {
  getDevConversionOverrides,
  setDevConversionOverrides,
  type DevConversionOverrides,
  type DevForcedCaptureMode,
  type DevForcedGifEncoder,
  type DevForcedStrategyCodec,
} from '@services/orchestration/dev-conversion-overrides';
import { convertVideo } from '@services/orchestration/conversion-orchestrator';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';

export interface ConversionMatrixTestParams {
  file: File;
  metadata?: VideoMetadata | null;
  formats: Array<Extract<ConversionFormat, 'gif' | 'webp'>>;
  repeats?: number;
  quality: ConversionOptions['quality'];
  scale: ConversionOptions['scale'];
  /** When true, include strategy-codec simulation scenarios (planning-only). */
  includeStrategyCodecScenarios?: boolean;
}

interface MatrixScenario {
  id: string;
  label: string;
  format: Extract<ConversionFormat, 'gif' | 'webp'>;
  overrides: Partial<DevConversionOverrides>;
}

export interface ConversionMatrixTestSummary {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  fileName: string;
  fileSizeBytes: number;
  repeats: number;
  totalRuns: number;
  successCount: number;
  errorCount: number;
}

const BASELINE_OVERRIDES: DevConversionOverrides = {
  forcedPath: 'auto',
  disableFallback: false,
  forcedGifEncoder: 'auto',
  forcedCaptureMode: 'auto',
  disableDemuxerInAuto: false,
  forcedStrategyCodec: 'auto',
};

function scenarioId(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined)
    .map((p) => String(p).replaceAll(/\s+/g, '-'))
    .join('__');
}

function applyScenarioOverrides(
  overrides: Partial<DevConversionOverrides>
): DevConversionOverrides {
  return setDevConversionOverrides({ ...BASELINE_OVERRIDES, ...overrides });
}

function buildCaptureModeScenarios(params: {
  format: Extract<ConversionFormat, 'gif' | 'webp'>;
  forcedGifEncoder?: DevForcedGifEncoder;
  forcedPath?: DevConversionOverrides['forcedPath'];
}): MatrixScenario[] {
  const { format, forcedGifEncoder, forcedPath } = params;

  const modes: DevForcedCaptureMode[] = ['auto', 'demuxer', 'track', 'frame-callback', 'seek'];
  const scenarios: MatrixScenario[] = [];

  for (const mode of modes) {
    // Base capture-mode scenario
    scenarios.push({
      id: scenarioId([format, forcedPath ?? 'auto', forcedGifEncoder ?? 'auto', 'capture', mode]),
      label: `${format.toUpperCase()} capture=${mode}`,
      format,
      overrides: {
        forcedPath,
        forcedGifEncoder,
        forcedCaptureMode: mode,
        disableDemuxerInAuto: false,
      },
    });

    // Auto-mode variants: disable demuxer
    if (mode === 'auto') {
      scenarios.push({
        id: scenarioId([
          format,
          forcedPath ?? 'auto',
          forcedGifEncoder ?? 'auto',
          'capture',
          'auto',
          'no-demux',
        ]),
        label: `${format.toUpperCase()} capture=auto (demuxer disabled)`,
        format,
        overrides: {
          forcedPath,
          forcedGifEncoder,
          forcedCaptureMode: 'auto',
          disableDemuxerInAuto: true,
        },
      });
    }
  }

  return scenarios;
}

function buildStrategyCodecScenarios(params: {
  format: Extract<ConversionFormat, 'gif' | 'webp'>;
}): MatrixScenario[] {
  const codecs: DevForcedStrategyCodec[] = ['h264', 'vp9', 'av1', 'unknown'];

  return codecs.map((forcedStrategyCodec) => ({
    id: scenarioId([params.format, 'strategy-codec', forcedStrategyCodec]),
    label: `${params.format.toUpperCase()} strategyCodec=${forcedStrategyCodec}`,
    format: params.format,
    overrides: {
      forcedPath: 'auto',
      forcedGifEncoder: 'auto',
      forcedCaptureMode: 'auto',
      disableDemuxerInAuto: false,
      forcedStrategyCodec,
    },
  }));
}

function buildScenarios(params: {
  formats: Array<Extract<ConversionFormat, 'gif' | 'webp'>>;
  includeStrategyCodecScenarios: boolean;
}): MatrixScenario[] {
  const scenarios: MatrixScenario[] = [];

  for (const format of params.formats) {
    // Baselines
    scenarios.push({
      id: scenarioId([format, 'baseline']),
      label: `${format.toUpperCase()} baseline (auto)`,
      format,
      overrides: { ...BASELINE_OVERRIDES },
    });

    scenarios.push({
      id: scenarioId([format, 'force', 'cpu']),
      label: `${format.toUpperCase()} forcedPath=cpu`,
      format,
      overrides: { ...BASELINE_OVERRIDES, forcedPath: 'cpu' },
    });

    scenarios.push({
      id: scenarioId([format, 'force', 'gpu']),
      label: `${format.toUpperCase()} forcedPath=gpu`,
      format,
      overrides: { ...BASELINE_OVERRIDES, forcedPath: 'gpu' },
    });

    // GPU capture-mode variations (format-agnostic)
    scenarios.push(
      ...buildCaptureModeScenarios({
        format,
        forcedPath: 'gpu',
      })
    );

    if (format === 'gif') {
      // GIF encoder variations
      scenarios.push({
        id: scenarioId([format, 'gif-encoder', 'modern-gif']),
        label: 'GIF forcedGifEncoder=modern-gif',
        format,
        overrides: {
          ...BASELINE_OVERRIDES,
          forcedGifEncoder: 'modern-gif',
          forcedPath: 'gpu',
        },
      });

      scenarios.push({
        id: scenarioId([format, 'gif-encoder', 'ffmpeg-direct']),
        label: 'GIF forcedGifEncoder=ffmpeg-direct',
        format,
        overrides: {
          ...BASELINE_OVERRIDES,
          forcedGifEncoder: 'ffmpeg-direct',
        },
      });

      scenarios.push({
        id: scenarioId([format, 'gif-encoder', 'ffmpeg-palette']),
        label: 'GIF forcedGifEncoder=ffmpeg-palette',
        format,
        overrides: {
          ...BASELINE_OVERRIDES,
          forcedGifEncoder: 'ffmpeg-palette',
        },
      });

      scenarios.push({
        id: scenarioId([format, 'gif-encoder', 'ffmpeg-palette-frames']),
        label: 'GIF forcedGifEncoder=ffmpeg-palette-frames',
        format,
        overrides: {
          ...BASELINE_OVERRIDES,
          forcedGifEncoder: 'ffmpeg-palette-frames',
          forcedPath: 'gpu',
        },
      });

      // Capture-mode variations specifically for the hybrid palette-from-frames path
      scenarios.push(
        ...buildCaptureModeScenarios({
          format,
          forcedPath: 'gpu',
          forcedGifEncoder: 'ffmpeg-palette-frames',
        })
      );

      scenarios.push(
        ...buildCaptureModeScenarios({
          format,
          forcedPath: 'gpu',
          forcedGifEncoder: 'modern-gif',
        })
      );
    }

    if (params.includeStrategyCodecScenarios) {
      scenarios.push(...buildStrategyCodecScenarios({ format }));
    }
  }

  // De-duplicate by id while preserving first occurrence ordering
  const seen = new Set<string>();
  const deduped: MatrixScenario[] = [];
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) continue;
    seen.add(scenario.id);
    deduped.push(scenario);
  }

  return deduped;
}

async function yieldToUI(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

export async function runConversionMatrixTest(
  params: ConversionMatrixTestParams
): Promise<ConversionMatrixTestSummary> {
  if (!import.meta.env.DEV) {
    throw new Error('Conversion matrix test is only available in dev builds.');
  }

  const repeats = Math.max(1, Math.floor(params.repeats ?? 3));
  const formats: Array<Extract<ConversionFormat, 'gif' | 'webp'>> =
    params.formats.length > 0 ? params.formats : (['gif'] as const);

  const scenarios = buildScenarios({
    formats,
    includeStrategyCodecScenarios: params.includeStrategyCodecScenarios === true,
  });

  const totalRuns = scenarios.length * repeats;
  const startedAt = Date.now();
  const perfStart = performance.now();

  let successCount = 0;
  let errorCount = 0;

  const initialOverrides = getDevConversionOverrides();

  logger.info('conversion', '=== Conversion Matrix Test: start ===', {
    fileName: params.file.name,
    fileSizeBytes: params.file.size,
    codec: params.metadata?.codec ?? 'unknown',
    durationSeconds: params.metadata?.duration ?? null,
    formats,
    repeats,
    scenarios: scenarios.length,
    totalRuns,
  });

  try {
    let runIndex = 0;

    for (const scenario of scenarios) {
      for (let i = 0; i < repeats; i++) {
        runIndex++;

        const effectiveOverrides = applyScenarioOverrides(scenario.overrides);

        const options: ConversionOptions = {
          quality: params.quality,
          scale: params.scale,
          duration:
            typeof params.metadata?.duration === 'number' && params.metadata.duration > 0
              ? params.metadata.duration
              : undefined,
        };

        const start = performance.now();

        logger.info('conversion', 'Matrix run start', {
          runIndex,
          totalRuns,
          scenarioId: scenario.id,
          scenarioLabel: scenario.label,
          iteration: i + 1,
          repeats,
          format: scenario.format,
          overrides: effectiveOverrides,
          quality: options.quality,
          scale: options.scale,
        });

        try {
          const result = await convertVideo({
            file: params.file,
            format: scenario.format,
            options,
            metadata: params.metadata ?? undefined,
            onProgress: () => undefined,
            onStatus: () => undefined,
          });

          const elapsedMs = Math.round(performance.now() - start);
          successCount++;

          logger.info('conversion', 'Matrix run success', {
            runIndex,
            totalRuns,
            scenarioId: scenario.id,
            scenarioLabel: scenario.label,
            iteration: i + 1,
            repeats,
            format: scenario.format,
            elapsedMs,
            outputSizeBytes: result.blob.size,
            executedPath: result.metadata.path,
            encoder: result.metadata.encoder,
            captureModeUsed: result.metadata.captureModeUsed ?? null,
            originalCodec: result.metadata.originalCodec ?? params.metadata?.codec ?? null,
          });
        } catch (error) {
          const elapsedMs = Math.round(performance.now() - start);
          errorCount++;

          logger.error('conversion', 'Matrix run error', {
            runIndex,
            totalRuns,
            scenarioId: scenario.id,
            scenarioLabel: scenario.label,
            iteration: i + 1,
            repeats,
            format: scenario.format,
            elapsedMs,
            error: getErrorMessage(error),
          });
        } finally {
          // Avoid holding onto large blobs or intermediate arrays. Yield to the event loop
          // to give the browser a chance to run GC between scenarios.
          await yieldToUI();
        }
      }
    }
  } finally {
    // Restore initial overrides for interactive debugging sessions.
    setDevConversionOverrides(initialOverrides);
  }

  const endedAt = Date.now();
  const durationMs = Math.round(performance.now() - perfStart);

  logger.info('conversion', '=== Conversion Matrix Test: complete ===', {
    fileName: params.file.name,
    fileSizeBytes: params.file.size,
    formats,
    repeats,
    scenarios: scenarios.length,
    totalRuns,
    successCount,
    errorCount,
    durationMs,
  });

  return {
    startedAt,
    endedAt,
    durationMs,
    fileName: params.file.name,
    fileSizeBytes: params.file.size,
    repeats,
    totalRuns,
    successCount,
    errorCount,
  };
}
