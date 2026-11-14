import { expect, it } from 'vite-plus/test';

import { selectRemovedUncachedAsset } from '../../../validation/windows/offline-recovery';

it('uses the retired codec when locale chunks did not change', () => {
  expect(
    selectRemovedUncachedAsset(
      ['index.old.js', 'gifenc.old.js', 'codec.old.wasm'],
      ['/assets/index.old.js']
    )
  ).toBe('gifenc.old.js');
});

it('does not fabricate a removed control or select a cached asset', () => {
  expect(
    selectRemovedUncachedAsset(['index.old.js', 'codec.old.wasm'], ['/assets/index.old.js'])
  ).toBeUndefined();
  expect(selectRemovedUncachedAsset([], [])).toBeUndefined();
});
