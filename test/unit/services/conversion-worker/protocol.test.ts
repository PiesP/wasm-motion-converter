// SPDX-License-Identifier: MIT
// Copyright (c) 2025-2026 PiesP

import { describe, expect, it } from 'vitest';
import {
  arrayBufferToHex,
  hexToArrayBuffer,
} from '@services/conversion-worker/protocol';

describe('protocol helpers', () => {
  describe('arrayBufferToHex', () => {
    it('encodes an empty ArrayBuffer to empty string', () => {
      expect(arrayBufferToHex(new ArrayBuffer(0))).toBe('');
    });

    it('encodes a single byte correctly', () => {
      const buf = new ArrayBuffer(1);
      new Uint8Array(buf)[0] = 255;
      expect(arrayBufferToHex(buf)).toBe('ff');
    });

    it('encodes multiple bytes correctly', () => {
      const buf = new ArrayBuffer(3);
      const bytes = new Uint8Array(buf);
      bytes[0] = 0x12;
      bytes[1] = 0x34;
      bytes[2] = 0xab;
      expect(arrayBufferToHex(buf)).toBe('1234ab');
    });

    it('produces lowercase hex', () => {
      const buf = new ArrayBuffer(1);
      new Uint8Array(buf)[0] = 0xaf;
      expect(arrayBufferToHex(buf)).toBe('af');
    });

    it('handles larger buffers', () => {
      const buf = new ArrayBuffer(4);
      new Uint8Array(buf).set([0xde, 0xad, 0xbe, 0xef]);
      expect(arrayBufferToHex(buf)).toBe('deadbeef');
    });
  });

  describe('hexToArrayBuffer', () => {
    it('decodes an empty string to empty ArrayBuffer', () => {
      const result = hexToArrayBuffer('');
      expect(result.byteLength).toBe(0);
    });

    it('decodes a single byte', () => {
      const result = hexToArrayBuffer('ff');
      expect(new Uint8Array(result)[0]).toBe(255);
    });

    it('round-trips arrayBufferToHex → hexToArrayBuffer', () => {
      const original = new ArrayBuffer(4);
      new Uint8Array(original).set([0x12, 0x34, 0xab, 0xcd]);
      const hex = arrayBufferToHex(original);
      const restored = hexToArrayBuffer(hex);
      expect(restored.byteLength).toBe(4);
      expect(new Uint8Array(restored)).toEqual(new Uint8Array(original));
    });

    it('handles odd-length hex by truncating last nibble', () => {
      // Odd length: "abc" → 1 byte ("ab"), "c" ignored
      const result = hexToArrayBuffer('abc');
      expect(result.byteLength).toBe(1);
      expect(new Uint8Array(result)[0]).toBe(0xab);
    });

    it('handles uppercase hex input', () => {
      const result = hexToArrayBuffer('DEADBEEF');
      expect(result.byteLength).toBe(4);
      expect(new Uint8Array(result)).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      );
    });
  });
});