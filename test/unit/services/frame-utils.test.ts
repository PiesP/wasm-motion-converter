import { convertRGBAToRGB } from '@services/frame-utils';
import { BufferPool } from '@services/buffer-pool';
import { describe, expect, it } from 'vitest';

describe('convertRGBAToRGB', () => {
  it('converts an unaligned Uint8Array view without reading outside the view', () => {
    const backing = new Uint8Array([255, 10, 20, 30, 40, 50, 60]);
    const source = backing.subarray(1, 5);
    const pool = new BufferPool(1, 1024);

    const result = convertRGBAToRGB(source, 1, 1, 'RGBA', pool);

    expect(Array.from(result.slice(0, 3))).toEqual([10, 20, 30]);
  });

  it('rejects a source view that does not contain a complete pixel payload', () => {
    const pool = new BufferPool(1, 1024);

    expect(() => convertRGBAToRGB(new Uint8Array([10, 20, 30]), 1, 1, 'RGBA', pool)).toThrow(
      RangeError
    );
  });
});
