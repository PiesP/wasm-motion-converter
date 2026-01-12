/**
 * Legacy Conversion Service (compatibility wrapper)
 *
 * NOTE: The app's runtime entrypoint is `@services/orchestration/conversion-orchestrator`.
 * This module is kept for backward compatibility with older imports and external
 * documentation, but it delegates all routing/logic to the orchestrator.
 */

import type {
  ConversionFormat,
  ConversionOptions,
  ConversionOutputBlob,
  VideoMetadata,
} from "@t/conversion-types";
import { convertVideo as orchestrateConversion } from "@services/orchestration/conversion-orchestrator";

/**
 * Convert video file to specified format.
 *
 * @deprecated Prefer `@services/orchestration/conversion-orchestrator`.
 */
export async function convertVideo(
  file: File,
  format: ConversionFormat,
  options: ConversionOptions,
  metadata?: VideoMetadata
): Promise<ConversionOutputBlob> {
  const result = await orchestrateConversion({
    file,
    format,
    options,
    metadata,
  });

  return result.blob;
}
