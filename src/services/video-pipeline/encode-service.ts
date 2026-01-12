/**
 * Encode Service
 *
 * Placeholder for the next-generation encode pipeline implementation.
 *
 * This file exists to match the required architecture layout and will
 * evolve to provide worker-backed encoders (gifski, FFmpeg, etc.).
 */

export type EncodePath = 'gifski' | 'ffmpeg' | 'webcodecs-webp';

class EncodeService {
  private static instance: EncodeService | null = null;

  static getInstance(): EncodeService {
    EncodeService.instance ??= new EncodeService();
    return EncodeService.instance;
  }

  private constructor() {}

  selectEncodePath(params: { format: 'gif' | 'webp' }): EncodePath {
    if (params.format === 'gif') {
      return 'gifski';
    }

    return 'webcodecs-webp';
  }
}

export const encodeService = EncodeService.getInstance();
