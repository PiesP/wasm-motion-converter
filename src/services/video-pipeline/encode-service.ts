/**
 * Encode Service
 *
 * Placeholder for the next-generation encode pipeline implementation.
 *
 * This file exists to match the required architecture layout and will
 * evolve to provide worker-backed encoders (gifski, FFmpeg, etc.).
 */

import { createSingleton } from '@services/shared/singleton-service';

// NOTE: This is a *planning* label used by video-pipeline diagnostics.
// The actual encoder backend can differ at runtime due to strategy selection,
// capability checks, and fallbacks.
export type EncodePlan = 'ffmpeg' | 'modern-gif' | 'encoder-factory-webp';

class EncodeService {
  selectEncodePlan(params: { format: 'gif' | 'webp' }): EncodePlan {
    if (params.format === 'gif') {
      return 'modern-gif';
    }

    return 'encoder-factory-webp';
  }
}

export const encodeService = createSingleton('EncodeService', () => new EncodeService());
