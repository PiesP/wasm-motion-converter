// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP

/**
 * Encoding strategy abstraction and fallback chain.
 *
 * Provides a clean pattern for multi-strategy encoding with automatic
 * fallback. Each strategy tries to encode; if it throws, the chain
 * moves to the next strategy. Errors are collected and reported when
 * all strategies fail.
 */

export interface EncodeRequest {
  /** Encoding format */
  format: 'gif' | 'webp';
}

export interface EncodeResponse {
  /** Encoded output blob */
  blob: Blob;
  /** Identifier of the strategy that succeeded */
  backendUsed: string;
}

export interface EncodingStrategy {
  /** Human-readable strategy name for logging */
  readonly name: string;

  /** Whether this strategy can handle the given format */
  canHandle(format: EncodeRequest['format']): boolean;

  /** Attempt encoding. Throw on failure to trigger next strategy. */
  encode(): Promise<EncodeResponse>;
}

/**
 * Ordered fallback chain — tries strategies in sequence until one succeeds.
 *
 * @example
 * ```ts
 * const chain = new FallbackChain([
 *   new ModernGifWorkerStrategy(pool, frames, options),
 *   new ModernGifMainStrategy(frames, options),
 *   new FFmpegFallbackStrategy(ffmpegService, ...),
 * ]);
 * const { blob, backendUsed } = await chain.execute('gif');
 * ```
 */
export class FallbackChain {
  constructor(private strategies: EncodingStrategy[]) {}

  async execute(format: EncodeRequest['format']): Promise<EncodeResponse> {
    const applicable = this.strategies.filter((s) => s.canHandle(format));

    if (!applicable.length) {
      throw new Error(`No encoding strategy available for ${format}`);
    }

    const errors: Array<{ name: string; message: string }> = [];

    for (const strategy of applicable) {
      try {
        return await strategy.encode();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ name: strategy.name, message });
      }
    }

    const errorSummary = errors.map((e) => `${e.name}: ${e.message}`).join('; ');
    throw new Error(
      `All ${errors.length} encoding strategies failed for ${format}: ${errorSummary}`
    );
  }
}
