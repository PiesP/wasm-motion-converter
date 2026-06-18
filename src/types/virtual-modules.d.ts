// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

/**
 * Virtual module type declarations.
 *
 * This project uses Vite virtual modules (provided by plugins) to keep
 * runtime CDN URL generation consistent across app code and workers.
 */

declare module 'virtual:cdn-deps' {
  /** Runtime dependency versions taken from package.json (dependencies + cdnDependencies). */
  export const RUNTIME_DEP_VERSIONS: Record<string, string>;
}
