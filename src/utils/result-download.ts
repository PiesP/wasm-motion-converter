// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

/** Keep fallback downloads named like the normal result view. */
export function resultDownloadName(originalName: string, mimeType: string): string {
  const extension = mimeType === 'image/gif' ? 'gif' : 'webp';
  const trimmed = originalName.trim();
  const lastDot = trimmed.lastIndexOf('.');
  const base = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  const safe = (base.trim() ? base : 'converted')
    .replace(/\.\.+/g, '_')
    .replace(/[/\\]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '');
  return `${safe || 'converted'}.${extension}`;
}
