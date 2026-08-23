// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { copyBoundedCodecDescription } from '@services/codec-description';
import type {
  SerializedConversionOptions,
  SerializedDecoderConfig,
} from '@services/conversion-worker/types';
import { calcMemoryPressureDecimation } from '@services/encoder-common';
import { resolveOutputLimits } from '@services/output-limits';
import type { ConversionSettings, VideoMetadata } from '@t/conversion-types';
import { DEFAULT_FPS, GIF_TARGET_FPS, WEBP_TARGET_FPS } from '@utils/constants';

export interface ConversionMemoryPlan {
  estimatedFrames: number;
  format: ConversionSettings['format'];
  height: number;
  sourceFps: number;
  targetFps: number;
  width: number;
}

type MemoryPressureLevel = 'ok' | 'warning' | 'critical';

export function buildConversionMemoryPlan(
  metadata: VideoMetadata | null,
  settings: ConversionSettings
): ConversionMemoryPlan | null {
  if (!metadata || settings.quality !== 'high' || settings.scale < 1) return null;

  const sourceFps = metadata.framerate ?? DEFAULT_FPS;
  return {
    estimatedFrames: metadata.duration > 0 ? Math.round(metadata.duration * sourceFps) : 300,
    format: settings.format,
    height: Math.max(1, Math.floor(metadata.height * settings.scale)),
    sourceFps,
    targetFps:
      settings.format === 'gif'
        ? GIF_TARGET_FPS[settings.quality]
        : WEBP_TARGET_FPS[settings.quality],
    width: Math.max(1, Math.floor(metadata.width * settings.scale)),
  };
}

export function resolveMemoryPressureDecimation(
  plan: ConversionMemoryPlan,
  level: MemoryPressureLevel
): number | undefined {
  if (level !== 'critical') return undefined;
  return calcMemoryPressureDecimation(plan.sourceFps, plan.targetFps);
}

export function serializeConversionInputs(
  metadata: VideoMetadata | null,
  forcedDecimation: number | undefined,
  settings: ConversionSettings
): {
  serializedConfig: SerializedDecoderConfig | null;
  serializedOptions: SerializedConversionOptions;
} {
  const outputLimits = resolveOutputLimits(settings.format);
  const metadataFps = metadata?.framerate;
  const fps =
    metadataFps !== undefined && Number.isFinite(metadataFps) && metadataFps > 0
      ? metadataFps
      : DEFAULT_FPS;
  return {
    serializedConfig: serializeDecoderConfig(metadata, settings.format === 'gif'),
    serializedOptions: {
      format: settings.format,
      quality: settings.quality,
      fps,
      scale: settings.scale,
      trimStart: settings.trimStart > 0 ? settings.trimStart : 0,
      trimEnd: settings.trimEnd > 0 ? settings.trimEnd : 0,
      maxFrames: outputLimits.maxFrames,
      maxOutputBytes: outputLimits.maxOutputBytes,
      forceDecimation: forcedDecimation,
      smartFrameSkip: settings.smartFrameSkip,
    },
  };
}

function serializeDecoderConfig(
  metadata: VideoMetadata | null,
  includeDescription: boolean
): SerializedDecoderConfig | null {
  const decoderConfig = metadata?.config;
  if (!decoderConfig) return null;

  return {
    codec: decoderConfig.codec,
    codedWidth: decoderConfig.codedWidth ?? 0,
    codedHeight: decoderConfig.codedHeight ?? 0,
    ...(decoderConfig.displayAspectWidth !== undefined
      ? { displayAspectWidth: decoderConfig.displayAspectWidth }
      : {}),
    ...(decoderConfig.displayAspectHeight !== undefined
      ? { displayAspectHeight: decoderConfig.displayAspectHeight }
      : {}),
    ...(decoderConfig.hardwareAcceleration
      ? { hardwareAcceleration: decoderConfig.hardwareAcceleration }
      : {}),
    ...(includeDescription && decoderConfig.description
      ? { description: copyBoundedCodecDescription(decoderConfig.description) }
      : {}),
  };
}
