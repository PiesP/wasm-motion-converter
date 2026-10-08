// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

// A constant-size declaration exceeds the production logical-count policy without
// constructing a large table or carrying media that could exhaust the test runner.
export function makeMp4BudgetFixture(original) {
  assert(original.byteLength > 0 && original.byteLength <= 8 * 1024 * 1024);
  const bytes = Buffer.from(original);
  let visited = 0;
  let sizeTable;
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const visit = (start, end, depth) => {
    assert(depth <= 8);
    for (let offset = start; offset + 8 <= end;) {
      assert(++visited <= 4096);
      const length = bytes.readUInt32BE(offset);
      const name = bytes.toString('ascii', offset + 4, offset + 8);
      assert(length >= 8 && length <= end - offset);
      if (name === 'stsz' && sizeTable === undefined) {
        assert(length >= 20);
        sizeTable = offset;
      }
      if (containers.has(name)) visit(offset + 8, offset + length, depth + 1);
      offset += length;
    }
  };
  visit(0, bytes.length, 0);
  assert(sizeTable !== undefined, 'Normal fixture has no ordinary sample-size table');
  const originalCount = bytes.readUInt32BE(sizeTable + 16);
  const declaredCount = 100_000_001;
  bytes.writeUInt32BE(1, sizeTable + 12);
  bytes.writeUInt32BE(declaredCount, sizeTable + 16);
  return { bytes, originalCount, declaredCount };
}
