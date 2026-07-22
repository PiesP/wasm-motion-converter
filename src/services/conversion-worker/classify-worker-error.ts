// SPDX-License-Identifier: MIT
// Copyright (c) 2024-2026 PiesP

/**
 * Classify a conversion error for worker context.
 *
 * Uses a compact subset of rules — the full classifyConversionError from
 * @utils/classify-conversion-error requires video metadata and i18n that
 * are unavailable in the worker. This provides basic classification that
 * mirrors the main thread's key categories.
 */
export function classifyWorkerError(message: string): string {
  const lower = message.toLowerCase();
  if (/memory|oom|wasm\s*memory|stack\s*overflow/i.test(lower)) return 'OUT_OF_MEMORY';
  if (/timed?\s*out|timeout|stall|watchdog/i.test(lower)) return 'TIMEOUT';
  if (/cancel|abort/i.test(lower)) return 'CANCELLED';
  if (/codec|unsupported|not\s*found|decod(?:er|e)\s*fail/i.test(lower))
    return 'CODEC_NOT_SUPPORTED';
  if (/avif|libavif|webp|libwebp|encod(?:er|ing)\s*(?:fail|error)/i.test(lower)) {
    return 'ENCODER_ERROR';
  }
  if (/demux|container|format|unable\s*to\s*parse/i.test(lower)) return 'DECODER_ERROR';
  return 'UNKNOWN';
}
