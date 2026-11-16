import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  inspectDeclaredMemory,
  inspectOwnedVp8Wasm,
} from '../../../scripts/build/build-owned-vp8-wasm';

const wasmHeader = [0, 97, 115, 109, 1, 0, 0, 0];
const boundedMemory = [5, 5, 1, 1, 1, 0x80, 0x18]; // min 1, max 3072 pages (192 MiB)

function moduleWith(sections: number[][]): Buffer {
  return Buffer.from([...wasmHeader, ...sections.flat()]);
}

describe('owned VP8 candidate WASM admission', () => {
  it('accepts the generated artifact within the declared memory and byte budgets', () => {
    const artifact = readFileSync(
      resolve(import.meta.dirname, '../../../crates/owned-vp8/owned-vp8.wasm')
    );
    expect(inspectOwnedVp8Wasm(artifact)).toMatchObject({
      maxLinearBytes: 192 * 1024 * 1024,
      initialLinearBytes: expect.any(Number),
    });
  });

  it('rejects absent, shared, oversized, and unbounded memory declarations', () => {
    expect(() => inspectDeclaredMemory(moduleWith([]))).toThrow('no declared memory');
    for (const memory of [
      [5, 3, 1, 0, 1], // no maximum
      [5, 5, 1, 3, 1, 0x80, 0x18], // shared memory
      [5, 5, 1, 1, 1, 0x81, 0x18], // maximum 3073 pages
      [5, 6, 1, 1, 0x81, 0x01, 0x80, 0x18], // initial memory above 8 MiB
    ]) {
      expect(() => inspectDeclaredMemory(moduleWith([memory]))).toThrow();
    }
    expect(inspectDeclaredMemory(moduleWith([boundedMemory]))).toEqual({
      minimumBytes: 65_536,
      maximumBytes: 192 * 1024 * 1024,
    });
  });

  it('rejects imports and missing ABI2 exports before instantiation', () => {
    const type = [1, 4, 1, 0x60, 0, 0];
    const importedFunction = [2, 7, 1, 1, 109, 1, 102, 0, 0];
    expect(() => inspectOwnedVp8Wasm(moduleWith([type, importedFunction, boundedMemory]))).toThrow(
      'must not import a runtime'
    );
    expect(() => inspectOwnedVp8Wasm(moduleWith([boundedMemory]))).toThrow('missing ABI2 export');
  });
});
