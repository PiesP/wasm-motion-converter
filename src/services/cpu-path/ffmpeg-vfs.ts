/**
 * FFmpeg Virtual File System
 *
 * Manages FFmpeg's virtual filesystem (VFS) for reading/writing files in WASM memory.
 * Provides safe wrappers for file operations with error handling, caching, and tracking.
 *
 * Features:
 * - Safe file I/O with comprehensive error handling
 * - Input file caching to avoid redundant file reads
 * - Known file tracking for efficient existence checks
 * - Automatic cache expiration with TTL
 * - Temporary file cleanup
 *
 * @module cpu-path/ffmpeg-vfs
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { getErrorMessage } from '@utils/error-utils';
import { FFMPEG_INTERNALS } from '@utils/ffmpeg-constants';
import { logger } from '@utils/logger';
import { validateOutputBytes } from '../ffmpeg/output-validation';

/**
 * FFmpeg VFS manager
 *
 * Manages virtual filesystem operations for FFmpeg WASM instance.
 */
export class FFmpegVFS {
  /** Track files known to exist in VFS for fast existence checks */
  private knownFiles: Set<string> = new Set();

  /** Current cached input file key */
  private cachedInputKey: string | null = null;

  /** Timer for input cache expiration */
  private inputCacheTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Get cached input key
   */
  getCachedInputKey(): string | null {
    return this.cachedInputKey;
  }

  /**
   * Generate cache key for a file
   *
   * Uses file name, size, and last modified timestamp to create unique key.
   */
  getFileCacheKey(file: File): string {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  /**
   * Set input cache with TTL
   *
   * @param key - Cache key for the input file
   * @param ttlMs - Time-to-live in milliseconds (default: 2 minutes)
   */
  setInputCache(key: string, ttlMs: number = FFMPEG_INTERNALS.INPUT_CACHE_TTL_MS): void {
    this.cachedInputKey = key;
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
    }
    this.inputCacheTimer = setTimeout(() => {
      this.cachedInputKey = null;
      this.inputCacheTimer = null;
    }, ttlMs);
  }

  /**
   * Clear input cache timer
   */
  clearInputCacheTimer(): void {
    if (this.inputCacheTimer) {
      clearTimeout(this.inputCacheTimer);
      this.inputCacheTimer = null;
    }
  }

  /**
   * Clear all known files tracking
   */
  clearKnownFiles(): void {
    this.knownFiles.clear();
  }

  /**
   * Safe wrapper for writing files to FFmpeg filesystem
   *
   * Logs and propagates errors for better debugging.
   *
   * @param ffmpeg - FFmpeg instance
   * @param fileName - Name of file in VFS
   * @param data - File data to write
   */
  async writeFile(ffmpeg: FFmpeg, fileName: string, data: Uint8Array | string): Promise<void> {
    try {
      const size = typeof data === 'string' ? data.length : data.byteLength;
      if (size === 0) {
        logger.warn('conversion', `Writing 0-byte file to VFS: ${fileName}`);
      }
      await ffmpeg.writeFile(fileName, data);
      this.knownFiles.add(fileName);
      logger.debug('conversion', `Wrote file: ${fileName}`, { size });
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('conversion', `Failed to write ${fileName}`, { error: message });
      throw new Error(`Failed to write ${fileName}: ${message}`);
    }
  }

  /**
   * Safe wrapper for reading files from FFmpeg filesystem
   *
   * Logs and propagates errors for better debugging.
   *
   * @param ffmpeg - FFmpeg instance
   * @param fileName - Name of file in VFS
   * @returns File data as Uint8Array
   */
  async readFile(ffmpeg: FFmpeg, fileName: string): Promise<Uint8Array> {
    try {
      const data = await ffmpeg.readFile(fileName);
      logger.debug('conversion', `Read file: ${fileName}`, {
        size: data.length,
      });
      return new Uint8Array(data as Uint8Array);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('conversion', `Failed to read ${fileName}`, { error: message });
      throw new Error(`Failed to read ${fileName}: ${message}`);
    }
  }

  /**
   * Safe wrapper for deleting files from FFmpeg filesystem
   *
   * Non-critical errors are logged but not propagated.
   *
   * @param ffmpeg - FFmpeg instance (optional, will skip if not provided)
   * @param fileName - Name of file in VFS
   */
  async deleteFile(ffmpeg: FFmpeg | null, fileName: string): Promise<void> {
    if (!ffmpeg) {
      return;
    }
    try {
      await ffmpeg.deleteFile(fileName);
      this.knownFiles.delete(fileName);
      logger.debug('conversion', `Deleted ${fileName}`);
    } catch (error) {
      // Silent failure - file might not exist
      logger.debug('conversion', `Could not delete ${fileName} (non-critical)`, {
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Check if a file exists in FFmpeg filesystem
   *
   * Uses Set-based tracking to avoid reading entire files into memory.
   *
   * @param fileName - Name of file in VFS
   * @returns True if file exists, false otherwise
   */
  fileExists(fileName: string): boolean {
    return this.knownFiles.has(fileName);
  }

  /**
   * Ensure input file is in FFmpeg VFS
   *
   * Checks cache first to avoid redundant file reads. If file is not cached or
   * cache is stale, reads file and writes to VFS.
   *
   * @param ffmpeg - FFmpeg instance
   * @param file - Input file to load
   */
  async ensureInputFile(ffmpeg: FFmpeg, file: File): Promise<void> {
    const key = this.getFileCacheKey(file);

    // Check if file is already cached in FFmpeg filesystem
    if (this.cachedInputKey === key) {
      const exists = this.fileExists(FFMPEG_INTERNALS.INPUT_FILE_NAME);
      if (exists) {
        logger.debug('conversion', 'Using cached input file', { key });
        return;
      }
    }

    // Prepare new input file
    await this.deleteFile(ffmpeg, FFMPEG_INTERNALS.INPUT_FILE_NAME);

    try {
      const data = await fetchFile(file);
      await this.writeFile(ffmpeg, FFMPEG_INTERNALS.INPUT_FILE_NAME, data);
      this.setInputCache(key);
      logger.debug('conversion', 'Input file prepared', { key, size: file.size });
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('conversion', 'Failed to prepare input file', { error: message });
      throw new Error(`Failed to prepare input file: ${message}`);
    }
  }

  /**
   * Clear cached input file
   *
   * Removes input file from VFS and clears cache tracking.
   *
   * @param ffmpeg - FFmpeg instance
   */
  async clearCachedInput(ffmpeg: FFmpeg | null): Promise<void> {
    this.clearInputCacheTimer();
    this.cachedInputKey = null;
    await this.deleteFile(ffmpeg, FFMPEG_INTERNALS.INPUT_FILE_NAME);
  }

  /**
   * Validate FFmpeg output file for correctness
   *
   * Checks file size and basic format validity.
   *
   * @param ffmpeg - FFmpeg instance
   * @param fileName - Output file to validate
   * @param expectedFormat - Expected output format (gif/webp)
   * @returns Object with valid flag and optional reason for failure
   */
  async validateOutputFile(
    ffmpeg: FFmpeg,
    fileName: string,
    expectedFormat: 'gif' | 'webp'
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      // Read file data (will throw if file doesn't exist)
      const data = await this.readFile(ffmpeg, fileName);

      const validation = validateOutputBytes(new Uint8Array(data), expectedFormat);
      if (!validation.valid) {
        logger.warn('conversion', 'Output file failed validation', {
          format: expectedFormat,
          size: data.length,
          reason: validation.reason,
        });
        return { valid: false, reason: validation.reason };
      }

      return { valid: true };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error('conversion', 'Failed to validate output file', {
        file: fileName,
        error: message,
      });
      return {
        valid: false,
        reason: `Failed to read output file: ${message}`,
      };
    }
  }

  /**
   * Clean up temporary files in FFmpeg virtual filesystem
   *
   * Deletes all known temporary files to prevent orphaned files and memory leaks.
   *
   * @param ffmpeg - FFmpeg instance
   */
  async cleanupTempFiles(ffmpeg: FFmpeg | null): Promise<void> {
    if (!ffmpeg) {
      return;
    }

    const tempFiles = [
      FFMPEG_INTERNALS.INPUT_FILE_NAME, // input.mp4
      FFMPEG_INTERNALS.PALETTE_FILE_NAME, // GIF palette file
      'output.gif', // GIF output
      'output.webp', // WebP output
      FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE, // H.264 intermediate
    ];

    logger.debug('conversion', 'Cleaning up temp files', { files: tempFiles });

    // Attempt to delete each temp file, ignoring errors
    for (const file of tempFiles) {
      try {
        await this.deleteFile(ffmpeg, file);
      } catch (error) {
        // Ignore errors during cleanup - file may not exist
        logger.debug('conversion', `Failed to delete temp file: ${file}`, { error });
      }
    }
  }

  /**
   * Delete multiple files
   *
   * @param ffmpeg - FFmpeg instance
   * @param fileNames - Array of file names to delete
   */
  async deleteFiles(ffmpeg: FFmpeg | null, fileNames: string[]): Promise<void> {
    await Promise.all(fileNames.map((file) => this.deleteFile(ffmpeg, file)));
  }

  /**
   * Handle conversion cleanup
   *
   * Manages input cache and deletes temporary files based on memory status.
   *
   * @param ffmpeg - FFmpeg instance
   * @param outputFileName - Output file to clean up
   * @param additionalFiles - Additional files to delete
   * @param isMemoryCritical - Function to check if memory is critical
   */
  async handleConversionCleanup(
    ffmpeg: FFmpeg | null,
    outputFileName: string,
    additionalFiles: string[] = [],
    isMemoryCritical: () => boolean
  ): Promise<void> {
    const files = [
      outputFileName,
      ...additionalFiles,
      FFMPEG_INTERNALS.AV1_TRANSCODE.TEMP_H264_FILE,
    ];

    // Manage input cache based on memory status
    if (isMemoryCritical()) {
      logger.debug('conversion', 'Memory critical - clearing cached input');
      await this.clearCachedInput(ffmpeg);
    } else if (this.cachedInputKey) {
      logger.debug('conversion', 'Refreshing input cache with shorter TTL');
      this.setInputCache(this.cachedInputKey, FFMPEG_INTERNALS.INPUT_CACHE_POST_CONVERT_MS);
    }

    // Delete all temporary files
    await this.deleteFiles(ffmpeg, files);
  }
}

/**
 * Create FFmpeg VFS manager instance
 *
 * @returns New FFmpegVFS instance
 */
export function createFFmpegVFS(): FFmpegVFS {
  return new FFmpegVFS();
}
