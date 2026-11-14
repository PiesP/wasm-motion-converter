// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import {
  activeOwnedInputGeneration,
  beginOwnedInputSelection,
  clearOwnedInputSelection,
  copyOwnedInputIndex,
  isOwnedInputIndexSnapshot,
  publishOwnedInputIndex,
} from '@services/owned-input-index-cache';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const token = 'a'.repeat(64);
const encodedIndex = () => {
  const bytes = new ArrayBuffer(96);
  new Uint8Array(bytes)[0] = 29;
  return bytes;
};

afterEach(() => clearOwnedInputSelection());

describe('selected input index ownership', () => {
  it('keeps a master for repeated jobs while each job owns a mutable transfer copy', () => {
    const source = new Blob(['same content']);
    const generation = beginOwnedInputSelection(source);
    expect(publishOwnedInputIndex(source, generation, encodedIndex(), token)).toBe(true);
    const first = copyOwnedInputIndex(source)!;
    expect(first).toMatchObject({ version: 1, generation, sourceSize: source.size });
    expect(isOwnedInputIndexSnapshot(first)).toBe(true);
    new Uint8Array(first.bytes)[0] = 0;
    const second = copyOwnedInputIndex(source)!;
    expect(new Uint8Array(second.bytes)[0]).toBe(29);
    expect(second.bytes).not.toBe(first.bytes);
    expect(new Blob(['same content'])).not.toBe(source);
    expect(copyOwnedInputIndex(new Blob(['same content']))).toBeNull();
  });

  it('rejects a late analysis after replacement and never clears the newer choice', () => {
    const original = new Blob(['same']);
    const replacement = new Blob(['same']);
    const oldGeneration = beginOwnedInputSelection(original);
    const currentGeneration = beginOwnedInputSelection(replacement);
    expect(activeOwnedInputGeneration(original)).toBeNull();
    expect(publishOwnedInputIndex(original, oldGeneration, encodedIndex(), token)).toBe(false);
    clearOwnedInputSelection(oldGeneration);
    expect(activeOwnedInputGeneration(replacement)).toBe(currentGeneration);
    expect(publishOwnedInputIndex(replacement, currentGeneration, encodedIndex(), token)).toBe(
      true
    );
    clearOwnedInputSelection(currentGeneration);
    expect(copyOwnedInputIndex(replacement)).toBeNull();
  });

  it('does not publish an aborted export or accept malformed transfer envelopes', () => {
    const source = new Blob(['video']);
    const generation = beginOwnedInputSelection(source);
    const controller = new AbortController();
    controller.abort();
    expect(
      publishOwnedInputIndex(source, generation, encodedIndex(), token, controller.signal)
    ).toBe(false);
    expect(copyOwnedInputIndex(source)).toBeNull();
    expect(
      isOwnedInputIndexSnapshot({
        version: 1,
        generation,
        sourceSize: source.size,
        fingerprint: token,
        bytes: new ArrayBuffer(8 * 1024 * 1024 + 1),
      })
    ).toBe(false);
  });
});
