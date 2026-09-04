// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/**
 * Probe decoder support without turning an unavailable or unreliable browser
 * capability query into a false negative.
 */
export async function checkVideoDecoderSupport(
  config: VideoDecoderConfig
): Promise<boolean | null> {
  if (typeof VideoDecoder === 'undefined') return null;

  try {
    const result = await VideoDecoder.isConfigSupported(config);
    if (result.supported === true) return true;
    if (result.supported === false) return false;
  } catch {
    // Conversion-time decoder setup remains the authoritative fallback.
  }

  return null;
}
