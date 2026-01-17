import { conversionMetricsService } from '@services/orchestration/conversion-metrics-service';
import { extendedCapabilityService } from '@services/video-pipeline/extended-capability-service';
import { computeRawvideoEligibility } from '@services/webcodecs/conversion/rawvideo-eligibility-service';
import type { ConversionOptions, GifEncoderPreference, VideoMetadata } from '@t/conversion-types';
import { isAv1Codec, isHevcCodec, isVp9Codec } from '@utils/codec-utils';
import { QUALITY_PRESETS } from '@utils/constants';
import { logger } from '@utils/logger';
import { getOptimalFPS } from '@utils/quality-optimizer';

type ResolveGifEncoderArgs = {
  path: 'gpu' | 'cpu' | 'webav';
  options: ConversionOptions;
  requestedGifEncoder: GifEncoderPreference | null;
  metadata?: VideoMetadata;
  hasDevForcedGifEncoder: boolean;
};

type GifEncoderStrategyResult = {
  options: ConversionOptions;
  resolved: GifEncoderPreference | null;
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { mobile?: boolean };
};

function getIsProbablyMobile(): boolean {
  if (typeof navigator === 'undefined') return false;

  const nav = navigator as NavigatorWithUserAgentData;
  if (typeof nav.userAgentData?.mobile === 'boolean') {
    return nav.userAgentData.mobile;
  }

  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getPresetFps(options: ConversionOptions): number {
  const preset = QUALITY_PRESETS.gif[options.quality];
  return 'fps' in preset ? preset.fps : 15;
}

function getTargetFps(options: ConversionOptions, metadata?: VideoMetadata): number {
  if (metadata?.framerate && metadata.framerate > 0) {
    return getOptimalFPS(metadata.framerate, options.quality, 'gif');
  }

  return getPresetFps(options);
}

function getDurationBudgetSeconds(options: ConversionOptions): number {
  const base = options.scale === 1.0 ? 8 : options.scale === 0.75 ? 12 : 20;
  const qualityAdjust = options.quality === 'high' ? -2 : options.quality === 'low' ? 2 : 0;
  return Math.max(6, base + qualityAdjust);
}

function getFrameBudget(options: ConversionOptions): number {
  const base = options.scale === 1.0 ? 280 : options.scale === 0.75 ? 360 : 520;
  const qualityAdjust = options.quality === 'high' ? -60 : 0;
  return Math.max(180, base + qualityAdjust);
}

function getRawByteRatioThreshold(
  options: ConversionOptions,
  durationSeconds: number | null
): number | null {
  if (durationSeconds === null) {
    return null;
  }

  let threshold = options.scale === 1.0 ? 0.6 : options.scale === 0.75 ? 0.65 : 0.72;

  if (durationSeconds > 10) {
    threshold -= 0.1;
  } else if (durationSeconds > 6) {
    threshold -= 0.05;
  }

  if (options.quality === 'high') {
    threshold -= 0.05;
  } else if (options.quality === 'low') {
    threshold += 0.03;
  }

  return Math.min(0.78, Math.max(0.45, threshold));
}

function getDurationSeconds(metadata?: VideoMetadata): number | null {
  return typeof metadata?.duration === 'number' && metadata.duration > 0 ? metadata.duration : null;
}

export function resolveGifEncoderStrategy(args: ResolveGifEncoderArgs): GifEncoderStrategyResult {
  const { path, options, requestedGifEncoder, metadata, hasDevForcedGifEncoder } = args;

  if (requestedGifEncoder === null) {
    return { options, resolved: null };
  }

  if (requestedGifEncoder === 'auto' && path === 'gpu' && !hasDevForcedGifEncoder) {
    const caps = extendedCapabilityService.getCached();
    const codec = metadata?.codec;
    const isComplexGifCodec = isAv1Codec(codec) || isHevcCodec(codec) || isVp9Codec(codec);

    const learnedGifEncoder = codec
      ? conversionMetricsService.getGifEncoderRecommendation(codec)
      : null;

    const isProbablyMobile = getIsProbablyMobile();
    const targetFps = getTargetFps(options, metadata);

    const rawEligibility = computeRawvideoEligibility({
      metadata,
      targetFps,
      scale: options.scale,
      format: 'gif',
      intent: 'auto',
    });

    const isLowMemoryDevice =
      (typeof rawEligibility.deviceMemoryGB === 'number' && rawEligibility.deviceMemoryGB < 4) ||
      (typeof rawEligibility.jsHeapSizeLimitMB === 'number' &&
        rawEligibility.jsHeapSizeLimitMB < 1536);

    const ffmpegThreadingAvailable =
      caps.crossOriginIsolated && caps.sharedArrayBuffer && caps.workerSupport;

    const durationSeconds = getDurationSeconds(metadata);
    const durationBudgetSeconds = getDurationBudgetSeconds(options);
    const frameBudget = getFrameBudget(options);
    const rawByteRatioThreshold = getRawByteRatioThreshold(options, durationSeconds);

    const estimatedRawBytes = rawEligibility.estimatedRawBytes ?? 0;
    const rawByteRatio =
      rawEligibility.rawvideoMaxBytes > 0 && estimatedRawBytes > 0
        ? estimatedRawBytes / rawEligibility.rawvideoMaxBytes
        : null;

    const withinDurationBudget =
      durationSeconds !== null &&
      Number.isFinite(durationSeconds) &&
      durationSeconds <= durationBudgetSeconds;

    const estimatedFramesForRaw = rawEligibility.estimatedFramesForRaw;
    const withinFrameBudget =
      typeof estimatedFramesForRaw === 'number' &&
      Number.isFinite(estimatedFramesForRaw) &&
      estimatedFramesForRaw > 0 &&
      estimatedFramesForRaw <= frameBudget;

    const withinRawByteRatioBudget =
      rawByteRatio !== null &&
      rawByteRatioThreshold !== null &&
      Number.isFinite(rawByteRatio) &&
      rawByteRatio <= rawByteRatioThreshold;

    const rawvideoHasHeadroom =
      rawEligibility.enabled &&
      estimatedRawBytes > 0 &&
      withinDurationBudget &&
      withinFrameBudget &&
      withinRawByteRatioBudget;

    const shouldConsiderAutoPalette =
      isComplexGifCodec &&
      ffmpegThreadingAvailable &&
      rawvideoHasHeadroom &&
      !isProbablyMobile &&
      !isLowMemoryDevice;

    const learnedPrefersModern =
      learnedGifEncoder?.recommendedEncoder === 'modern-gif-worker' &&
      learnedGifEncoder.confidence >= 0.5;
    const learnedPrefersPalette =
      learnedGifEncoder?.recommendedEncoder === 'ffmpeg-palette' &&
      learnedGifEncoder.confidence >= 0.6;

    const allowAutoPaletteForCodec = isAv1Codec(codec) ? learnedPrefersPalette : true;

    if (shouldConsiderAutoPalette && allowAutoPaletteForCodec && !learnedPrefersModern) {
      logger.info('conversion', 'Auto GIF encoder resolved to FFmpeg palette (rawvideo eligible)', {
        requested: requestedGifEncoder,
        resolved: 'ffmpeg-palette',
        codec,
        isComplexGifCodec,
        learnedGifEncoder,
        crossOriginIsolated: caps.crossOriginIsolated,
        sharedArrayBuffer: caps.sharedArrayBuffer,
        workerSupport: caps.workerSupport,
        isProbablyMobile,
        isLowMemoryDevice,
        durationSeconds,
        durationBudgetSeconds,
        withinDurationBudget,
        targetFps,
        estimatedFramesForRaw,
        frameBudget,
        withinFrameBudget,
        estimatedRawBytes: rawEligibility.estimatedRawBytes,
        rawvideoMaxBytes: rawEligibility.rawvideoMaxBytes,
        rawByteRatio,
        rawByteRatioThreshold,
        withinRawByteRatioBudget,
        jsHeapSizeLimitMB: rawEligibility.jsHeapSizeLimitMB,
        deviceMemoryGB: rawEligibility.deviceMemoryGB,
        isMemoryCritical: rawEligibility.isMemoryCritical,
      });

      return {
        options: { ...options, gifEncoder: 'ffmpeg-palette' },
        resolved: 'ffmpeg-palette',
      };
    }

    logger.debug('conversion', 'Auto GIF encoder kept default', {
      requested: requestedGifEncoder,
      resolved: requestedGifEncoder,
      codec,
      isComplexGifCodec,
      ffmpegThreadingAvailable,
      rawvideoEligible: rawEligibility.enabled,
      rawvideoHasHeadroom,
      isProbablyMobile,
      isLowMemoryDevice,
      learnedGifEncoder,
      durationSeconds,
      durationBudgetSeconds,
      withinDurationBudget,
      estimatedRawBytes: rawEligibility.estimatedRawBytes,
      rawvideoMaxBytes: rawEligibility.rawvideoMaxBytes,
      rawByteRatio,
      rawByteRatioThreshold,
      withinRawByteRatioBudget,
      estimatedFramesForRaw,
      frameBudget,
      withinFrameBudget,
      isMemoryCritical: rawEligibility.isMemoryCritical,
    });
  }

  return { options, resolved: requestedGifEncoder };
}
