// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Error Recovery
 *
 * Output validation utilities.
 * Error classification is handled by classifyConversionError() in
 * utils/classify-conversion-error.ts which provides both structured codes
 * and user-friendly suggestions in a single pass.
 */

import type { ConversionFormat } from '@t/conversion-types';
import { isAnimatedAvif } from './avif-format';

/** Validate output file header (header-only check, no need to read full file) */
export function validateOutput(output: Uint8Array, format: ConversionFormat): boolean {
  // Minimum bytes needed: GIF=6 (header), WebP=12 (RIFF+size+WEBP)
  if (output.length < 6) return false;

  if (format === 'gif') {
    const header = new TextDecoder().decode(output.slice(0, 6));
    if (header !== 'GIF89a' && header !== 'GIF87a') return false;
    // Trailer byte (0x3b) check requires full file — skip for header-only validation
  } else if (format === 'webp') {
    if (output.length < 12) return false;
    const riff = new TextDecoder().decode(output.slice(0, 4));
    const webp = new TextDecoder().decode(output.slice(8, 12));
    if (riff !== 'RIFF' || webp !== 'WEBP') return false;
    // Size check requires full file — skip for header-only validation
  } else {
    return isAnimatedAvif(output);
  }

  return true;
}
