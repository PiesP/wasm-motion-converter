/**
 * Blob extension types for metadata attachment
 *
 * Provides type-safe way to attach conversion metadata to Blob objects
 * without using unsafe `any` casts
 */

/**
 * Extended Blob type with transcoding metadata
 *
 * Used to track whether a video blob has been transcoded from one codec to another
 * This helps determine if additional processing is needed
 */
export interface TranscodedBlob extends Blob {
  /**
   * Whether this blob has been transcoded (codec changed)
   */
  wasTranscoded?: boolean;

  /**
   * Original codec before transcoding (if transcoded)
   */
  originalCodec?: string;

  /**
   * Target codec after transcoding (if transcoded)
   */
  targetCodec?: string;

  /**
   * Conversion method used (e.g., 'ffmpeg', 'webcodecs')
   */
  conversionMethod?: 'ffmpeg' | 'webcodecs' | 'hybrid';
}

/**
 * Create a TranscodedBlob from a regular Blob with metadata
 *
 * @param blob - Source blob
 * @param wasTranscoded - Whether video was transcoded
 * @param originalCodec - Original codec (optional)
 * @param targetCodec - Target codec (optional)
 * @param conversionMethod - Conversion method used (optional)
 * @returns TranscodedBlob with metadata attached
 *
 * @example
 * ```typescript
 * const outputBlob = await ffmpeg.readFile('output.mp4');
 * const blob = new Blob([outputBlob], { type: 'video/mp4' });
 *
 * const transcodedBlob = createTranscodedBlob(
 *   blob,
 *   true,
 *   'av1',
 *   'h264',
 *   'ffmpeg'
 * );
 *
 * // Type-safe access
 * if (transcodedBlob.wasTranscoded) {
 *   console.log(`Transcoded from ${transcodedBlob.originalCodec}`);
 * }
 * ```
 */
export function createTranscodedBlob(
  blob: Blob,
  wasTranscoded: boolean,
  originalCodec?: string,
  targetCodec?: string,
  conversionMethod?: 'ffmpeg' | 'webcodecs' | 'hybrid'
): TranscodedBlob {
  const transcodedBlob = blob as TranscodedBlob;

  transcodedBlob.wasTranscoded = wasTranscoded;

  if (originalCodec !== undefined) {
    transcodedBlob.originalCodec = originalCodec;
  }

  if (targetCodec !== undefined) {
    transcodedBlob.targetCodec = targetCodec;
  }

  if (conversionMethod !== undefined) {
    transcodedBlob.conversionMethod = conversionMethod;
  }

  return transcodedBlob;
}

/**
 * Type guard to check if a Blob is a TranscodedBlob
 *
 * @param blob - Blob to check
 * @returns true if blob has transcoding metadata
 */
export function isTranscodedBlob(blob: Blob): blob is TranscodedBlob {
  return 'wasTranscoded' in blob && typeof (blob as TranscodedBlob).wasTranscoded === 'boolean';
}

/**
 * Get transcoding metadata from a Blob if available
 *
 * @param blob - Blob to extract metadata from
 * @returns Transcoding metadata or null if not a TranscodedBlob
 *
 * @example
 * ```typescript
 * const metadata = getTranscodingMetadata(blob);
 * if (metadata?.wasTranscoded) {
 *   console.log(`Video transcoded: ${metadata.originalCodec} → ${metadata.targetCodec}`);
 * }
 * ```
 */
export function getTranscodingMetadata(blob: Blob): {
  wasTranscoded: boolean;
  originalCodec?: string;
  targetCodec?: string;
  conversionMethod?: 'ffmpeg' | 'webcodecs' | 'hybrid';
} | null {
  if (!isTranscodedBlob(blob)) {
    return null;
  }

  return {
    wasTranscoded: blob.wasTranscoded ?? false,
    originalCodec: blob.originalCodec,
    targetCodec: blob.targetCodec,
    conversionMethod: blob.conversionMethod,
  };
}
