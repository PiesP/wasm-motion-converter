/**
 * Frame validation utilities
 *
 * Provides reusable functions for validating video frames during decoding
 * to detect empty, corrupt, or invalid frame data
 */

import { logger } from './logger';

/**
 * Check if VideoFrame is valid (not closed/null)
 *
 * @param frame - VideoFrame to validate
 * @returns true if frame is valid
 */
export function isValidVideoFrame(frame: VideoFrame | null): frame is VideoFrame {
  return frame !== null && typeof frame.close === 'function';
}

/**
 * Check if ImageData contains valid pixel data
 *
 * @param imageData - ImageData to validate
 * @returns true if ImageData has pixels
 *
 * @example
 * ```typescript
 * const imageData = context.getImageData(0, 0, width, height);
 * if (!isValidImageData(imageData)) {
 *   console.warn('Empty frame detected');
 *   return;
 * }
 * ```
 */
export function isValidImageData(imageData: ImageData | null | undefined): imageData is ImageData {
  return imageData !== null && imageData !== undefined && imageData.data.length > 0;
}

/**
 * Check if Blob contains data
 *
 * @param blob - Blob to validate
 * @returns true if Blob has size > 0
 */
export function isValidBlob(blob: Blob | null | undefined): blob is Blob {
  return blob !== null && blob !== undefined && blob.size > 0;
}

/**
 * Check if Uint8Array contains data
 *
 * @param data - Uint8Array to validate
 * @returns true if array has length > 0
 */
export function isValidFrameData(data: Uint8Array | null | undefined): data is Uint8Array {
  return data !== null && data !== undefined && data.byteLength > 0;
}

/**
 * Validate frame dimensions are positive and reasonable
 *
 * @param width - Frame width
 * @param height - Frame height
 * @param maxDimension - Maximum allowed dimension (default 8192)
 * @throws Error if dimensions are invalid
 */
export function validateFrameDimensions(width: number, height: number, maxDimension = 8192): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Invalid frame dimensions: ${width}x${height} (not finite)`);
  }

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid frame dimensions: ${width}x${height} (must be positive)`);
  }

  if (width > maxDimension || height > maxDimension) {
    throw new Error(`Frame dimensions ${width}x${height} exceed maximum ${maxDimension}px`);
  }
}

/**
 * Tracker for consecutive empty frames
 * Used to detect decoder failures or codec incompatibilities
 */
export class EmptyFrameTracker {
  private consecutiveEmptyCount = 0;
  private readonly maxConsecutiveEmpty: number;
  private readonly onMaxReached?: (count: number) => void;

  /**
   * @param maxConsecutiveEmpty - Maximum allowed consecutive empty frames before error
   * @param onMaxReached - Optional callback when max is reached
   */
  constructor(maxConsecutiveEmpty = 2, onMaxReached?: (count: number) => void) {
    this.maxConsecutiveEmpty = maxConsecutiveEmpty;
    this.onMaxReached = onMaxReached;
  }

  /**
   * Record an empty frame and check if max consecutive limit reached
   *
   * @param frameIndex - Current frame index for logging
   * @returns true if max consecutive empty frames reached
   * @throws Error if max consecutive empty frames exceeded
   */
  recordEmptyFrame(frameIndex: number): boolean {
    this.consecutiveEmptyCount += 1;

    logger.warn('conversion', `Empty frame detected at index ${frameIndex}`, {
      consecutiveEmptyFrames: this.consecutiveEmptyCount,
      maxAllowed: this.maxConsecutiveEmpty,
    });

    if (this.consecutiveEmptyCount >= this.maxConsecutiveEmpty) {
      this.onMaxReached?.(this.consecutiveEmptyCount);

      throw new Error(
        `Decoder produced ${this.consecutiveEmptyCount} consecutive empty frames at frame ${frameIndex}. ` +
          'This typically indicates codec incompatibility or decoder failure.'
      );
    }

    return false;
  }

  /**
   * Record a valid (non-empty) frame and reset consecutive counter
   */
  recordValidFrame(): void {
    this.consecutiveEmptyCount = 0;
  }

  /**
   * Get current consecutive empty frame count
   */
  getConsecutiveCount(): number {
    return this.consecutiveEmptyCount;
  }

  /**
   * Reset the tracker
   */
  reset(): void {
    this.consecutiveEmptyCount = 0;
  }
}

/**
 * Validate frame data and track consecutive empty frames
 *
 * Convenience function combining validation and tracking
 *
 * @param data - Frame data to validate (ImageData, Blob, or Uint8Array)
 * @param frameIndex - Current frame index
 * @param tracker - EmptyFrameTracker instance
 * @returns true if frame is valid
 * @throws Error if max consecutive empty frames exceeded
 *
 * @example
 * ```typescript
 * const tracker = new EmptyFrameTracker(2);
 *
 * for (let i = 0; i < frames.length; i++) {
 *   const imageData = captureFrame(i);
 *
 *   if (!validateFrameWithTracking(imageData, i, tracker)) {
 *     continue; // Skip empty frame
 *   }
 *
 *   // Process valid frame
 *   processFrame(imageData);
 * }
 * ```
 */
export function validateFrameWithTracking(
  data: ImageData | Blob | Uint8Array | null | undefined,
  frameIndex: number,
  tracker: EmptyFrameTracker
): boolean {
  // Check if frame is valid based on type
  let isValid = false;

  if (data instanceof ImageData) {
    isValid = isValidImageData(data);
  } else if (data instanceof Blob) {
    isValid = isValidBlob(data);
  } else if (data instanceof Uint8Array) {
    isValid = isValidFrameData(data);
  }

  // Track empty frames
  if (!isValid) {
    tracker.recordEmptyFrame(frameIndex); // Throws if max exceeded
    return false;
  }

  // Reset counter on valid frame
  tracker.recordValidFrame();
  return true;
}
