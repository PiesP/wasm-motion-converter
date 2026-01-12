/**
 * Demuxer Manager
 *
 * Manages demuxer lifecycle and provides clean API for demuxer operations.
 * Wraps demuxer-factory.ts with resource tracking and cleanup.
 *
 * Features:
 * - Automatic demuxer selection (MP4Box for MP4/MOV, WebM demuxer for WebM/MKV)
 * - Resource tracking and cleanup
 * - Eligibility checking
 */

import type { VideoMetadata } from '@t/conversion-types';
import { getErrorMessage } from '@utils/error-utils';
import { logger } from '@utils/logger';
import type { DemuxerAdapter } from '@services/webcodecs/demuxer/demuxer-adapter';
import {
  canUseDemuxer,
  createDemuxer,
  detectContainer,
} from '@services/webcodecs/demuxer/demuxer-factory';

/**
 * Demuxer manager class
 *
 * Provides high-level API for demuxer operations with automatic cleanup.
 */
export class DemuxerManager {
  private activeDemuxers = new Set<DemuxerAdapter>();

  /**
   * Check if demuxer can be used for this file
   *
   * Requirements:
   * 1. Container must be supported (MP4/MOV/WebM/MKV)
   * 2. WebCodecs VideoDecoder must be available
   * 3. Codec must be WebCodecs-compatible
   *
   * @param file - Video file to check
   * @param metadata - Optional video metadata
   * @returns True if demuxer can be used
   */
  canDemux(file: File, metadata?: VideoMetadata): boolean {
    return canUseDemuxer(file, metadata);
  }

  /**
   * Get container format for file
   *
   * @param file - Video file
   * @returns Container format (mp4, mov, webm, mkv, unknown)
   */
  getContainerFormat(file: File): string {
    return detectContainer(file);
  }

  /**
   * Create demuxer for file
   *
   * Automatically selects appropriate demuxer based on container format.
   * Tracks created demuxer for cleanup.
   *
   * @param file - Video file to demux
   * @param metadata - Optional video metadata
   * @returns DemuxerAdapter instance or null if not eligible
   * @throws Error if demuxer creation fails
   */
  async create(file: File, metadata?: VideoMetadata): Promise<DemuxerAdapter | null> {
    const demuxer = await createDemuxer(file, metadata);

    if (demuxer) {
      this.activeDemuxers.add(demuxer);
      logger.debug('demuxer', 'Created demuxer', {
        container: detectContainer(file),
        fileName: file.name,
        activeCount: this.activeDemuxers.size,
      });
    }

    return demuxer;
  }

  /**
   * Destroy specific demuxer
   *
   * Cleans up demuxer resources and removes from tracking.
   *
   * @param demuxer - Demuxer to destroy
   */
  destroy(demuxer: DemuxerAdapter): void {
    if (!this.activeDemuxers.has(demuxer)) {
      return;
    }

    try {
      demuxer.destroy();
      this.activeDemuxers.delete(demuxer);
      logger.debug('demuxer', 'Destroyed demuxer', {
        remainingCount: this.activeDemuxers.size,
      });
    } catch (error) {
      logger.warn('demuxer', 'Error destroying demuxer', {
        error: getErrorMessage(error),
      });
      // Still remove from tracking even if destroy fails
      this.activeDemuxers.delete(demuxer);
    }
  }

  /**
   * Destroy all active demuxers
   *
   * Cleans up all tracked demuxers. Safe to call multiple times.
   */
  destroyAll(): void {
    const count = this.activeDemuxers.size;
    if (count === 0) {
      return;
    }

    logger.debug('demuxer', 'Destroying all demuxers', {
      count,
    });

    // Copy set to avoid modification during iteration
    const demuxers = Array.from(this.activeDemuxers);
    for (const demuxer of demuxers) {
      this.destroy(demuxer);
    }
  }

  /**
   * Get number of active demuxers
   *
   * @returns Active demuxer count
   */
  getActiveCount(): number {
    return this.activeDemuxers.size;
  }
}

/**
 * Global demuxer manager instance
 */
export const demuxerManager = new DemuxerManager();
