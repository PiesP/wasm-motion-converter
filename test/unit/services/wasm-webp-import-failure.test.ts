// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP
import { expect, it, vi } from 'vite-plus/test';
const original = vi.hoisted(() => new Error('Bounded module evaluation failure'));
vi.mock('wasm-webp/dist/esm/webp-wasm.js', () => {
  throw original;
});
it('distinguishes import/evaluation failure and retains its original cause', async () => {
  const { encodeRGBReuse } = await import('@services/wasm-webp-singleton');
  const first = await encodeRGBReuse(new Uint8Array(3), 1, 1).catch((error: unknown) => error);
  expect(first).toMatchObject({ stage: 'import' });
  // Vitest wraps failed mock factories, so the original remains in the cause chain.
  expect(first).toBeInstanceOf(Error);
  await expect(encodeRGBReuse(new Uint8Array(3), 1, 1)).rejects.toBe(first);
});
