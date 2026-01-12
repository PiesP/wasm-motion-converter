/**
 * Encode Service
 *
 * Placeholder for the next-generation encode pipeline implementation.
 *
 * This file exists to match the required architecture layout and will
 * evolve to provide worker-backed encoders (gifski, FFmpeg, etc.).
 */

import { createSingleton } from "@services/shared/singleton-service";

export type EncodePath = "gifski" | "ffmpeg" | "webcodecs-webp";

class EncodeService {
  selectEncodePath(params: { format: "gif" | "webp" }): EncodePath {
    if (params.format === "gif") {
      return "gifski";
    }

    return "webcodecs-webp";
  }
}

export const encodeService = createSingleton(
  "EncodeService",
  () => new EncodeService()
);
