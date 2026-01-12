/**
 * Decode Service
 *
 * Placeholder for the next-generation decode pipeline implementation.
 *
 * This file exists to match the required architecture layout and will
 * evolve to provide a unified decode API across WebCodecs and FFmpeg.
 */

import type { PipelineType, VideoTrackInfo } from '@t/video-pipeline-types';

export class DecodeService {
  private static instance: DecodeService | null = null;

  static getInstance(): DecodeService {
    DecodeService.instance ??= new DecodeService();
    return DecodeService.instance;
  }

  private constructor() {}

  /**
   * Decode entry point (not yet implemented).
   */
  decode(_params: { file: File; pipeline: PipelineType; track: VideoTrackInfo }): Promise<never> {
    return Promise.reject(new Error('DecodeService.decode is not implemented yet.'));
  }
}

export const decodeService = DecodeService.getInstance();
