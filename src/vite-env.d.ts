// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Vite Environment Types
 *
 * Extends global types for environment variable definitions with type safety.
 */

/// <reference types="vite/client" />

declare module '*.json' {
  const value: Record<string, string>;
  export default value;
}

declare module './i18n/*.json' {
  import type { Translations } from '@t/i18n-types';

  const value: Translations;
  export default value;
}

/* ============================================================================
   Vite Environment Variables
   ============================================================================ */

declare global {
  /**
   * Type-safe environment variables accessible via import.meta.env
   *
   * @remarks
   * Variables prefixed with VITE_ are exposed to the client-side code.
   * undefined values indicate optional configuration that isn't required
   * for the application to function.
   *
   /** Configuration:
    * - VITE_DEBUG_APP: Enable general application debug logging
    */
  interface ImportMetaEnv {
    /** Enable general app debug logging as "true" or "false" string (optional) */
    readonly VITE_DEBUG_APP?: string;
  }

  /**
   * Extended ImportMeta to include typed env variables
   *
   * @remarks
   * Provides import.meta.env with full TypeScript support for all
   * VITE_* environment variables defined above.
   */
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
