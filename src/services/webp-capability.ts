// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { extractCanvasWebp, validateVp8Frame } from './webp-bitstream';

/** Confirm that Canvas WebP produces the opaque VP8 keyframes required by ANMF. */
export async function probeCanvasWebpCapability(quality: number): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    const canvas = new OffscreenCanvas(2, 2);
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 2, 2);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (blob.type !== 'image/webp' || blob.size === 0) return false;
    validateVp8Frame(extractCanvasWebp(new Uint8Array(await blob.arrayBuffer())).bitstream, 2, 2);
    return true;
  } catch {
    return false;
  }
}
