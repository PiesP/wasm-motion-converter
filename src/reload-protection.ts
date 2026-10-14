// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

export function canReload(busy: boolean, hasResults: boolean): boolean {
  return !busy && !hasResults;
}

/** Re-read current state at activation; a disabled button is not the guard. */
export function reloadWhenSafe(
  isBusy: () => boolean,
  hasResults: () => boolean,
  navigate: () => void = () => window.location.reload()
): void {
  if (canReload(isBusy(), hasResults())) navigate();
}
