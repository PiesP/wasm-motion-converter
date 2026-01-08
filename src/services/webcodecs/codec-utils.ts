// Internal imports
import { COMPLEX_CODECS } from '../../utils/constants';

/**
 * Check if codec is complex (requires special handling).
 *
 * Complex codecs like AV1, VP9, and HEVC require direct WebCodecs frame extraction
 * to avoid double transcoding overhead.
 *
 * @param codec - Video codec string (e.g., 'av01', 'vp09', 'hev1')
 * @returns True if codec is in the complex codec list
 */
export function isComplexCodec(codec?: string): boolean {
  if (!codec || codec === 'unknown') {
    return false;
  }
  const normalized = codec.toLowerCase();
  return COMPLEX_CODECS.some((entry) => normalized.includes(entry));
}
