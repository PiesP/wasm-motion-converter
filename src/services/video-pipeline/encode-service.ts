/**
 * Encode Service
 *
 * Placeholder for the next-generation encode pipeline implementation.
 *
 * This file exists to match the required architecture layout and will
 * evolve to provide worker-backed encoders (gifski, FFmpeg, etc.).
 */

import { createSingleton } from "@services/shared/singleton-service";
import { isH264Codec } from "@utils/codec-utils";

// NOTE: This is a *planning* label used by video-pipeline diagnostics.
// The actual encoder backend can differ at runtime due to strategy selection,
// capability checks, and fallbacks.
export type EncodePlan = "ffmpeg" | "modern-gif" | "encoder-factory-webp";

class EncodeService {
  selectEncodePlan(params: {
    format: "gif" | "webp";
    codec?: string | null;
  }): EncodePlan {
    if (params.format === "gif") {
      // For H.264, CPU palettegen is typically faster and more reliable than
      // WebCodecs frame extraction + GIF encoding.
      if (params.codec && isH264Codec(params.codec)) {
        return "ffmpeg";
      }
      return "modern-gif";
    }

    return "encoder-factory-webp";
  }
}

export const encodeService = createSingleton(
  "EncodeService",
  () => new EncodeService()
);
