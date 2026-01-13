/**
 * Encode Service
 *
 * Placeholder for the next-generation encode pipeline implementation.
 *
 * This file exists to match the required architecture layout and will
 * evolve to provide worker-backed encoders (gifski, FFmpeg, etc.).
 */

import { createSingleton } from '@services/shared/singleton-service';
import { isAv1Codec, isH264Codec, isHevcCodec, normalizeCodecString } from '@utils/codec-utils';

// NOTE: This is a *planning* label used by video-pipeline diagnostics.
// The actual encoder backend can differ at runtime due to strategy selection,
// capability checks, and fallbacks.
export type EncodePlan = 'ffmpeg' | 'modern-gif' | 'encoder-factory-webp';

class EncodeService {
  selectEncodePlan(params: { format: 'gif' | 'webp'; codec?: string | null }): EncodePlan {
    if (params.format === 'gif') {
      const normalized = normalizeCodecString(params.codec ?? undefined);
      if (isAv1Codec(normalized) || isHevcCodec(normalized)) {
        return 'modern-gif';
      }
      if (
        isH264Codec(normalized) ||
        normalized.includes('vp8') ||
        normalized.includes('vp09') ||
        normalized.includes('vp9')
      ) {
        return 'ffmpeg';
      }

      return 'modern-gif';
    }

    return 'encoder-factory-webp';
  }
}

export const encodeService = createSingleton('EncodeService', () => new EncodeService());
