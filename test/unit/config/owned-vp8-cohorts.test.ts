import { describe, expect, it } from 'vite-plus/test';

import { selectFixtureCohort } from '../../../scripts/test/owned-vp8-v2-compare';
import { CORRECTION_PHOTO } from '../../../scripts/test/owned-vp8-v2-correction-fixtures';
import { EXTERNAL_SOURCES, FIXTURES } from '../../../scripts/test/owned-vp8-v2-fixtures';

describe('owned VP8 prospective cohort isolation', () => {
  it('requires an explicit regression purpose for the exposed initial held-out set', () => {
    expect(() => selectFixtureCohort('held-out', 'initial-v1')).toThrow('exposed');
    expect(selectFixtureCohort('held-out', 'initial-v1', true)).toEqual(
      FIXTURES.filter((item) => item.split === 'held-out')
    );
  });

  it('keeps fresh acceptance separate from old held-out and new tuning inputs', () => {
    const fresh = selectFixtureCohort('held-out', 'corrected-v2');
    const exposed = new Set(
      FIXTURES.filter((item) => item.split === 'held-out').map((item) => item.id)
    );
    const tuning = new Set(selectFixtureCohort('tuning', 'corrected-v2').map((item) => item.id));
    expect(fresh.every((item) => !exposed.has(item.id) && !tuning.has(item.id))).toBe(true);
    expect(CORRECTION_PHOTO.sha256).not.toBe(EXTERNAL_SOURCES.photo.sha256);
    const duplicate = fresh.find((item) => item.repeatOf);
    const original = fresh.find((item) => item.id === duplicate?.repeatOf);
    expect(original).toBeDefined();
    expect(duplicate?.frame).toBe(original?.frame);
    expect(duplicate?.source).toBe(original?.source);
  });
});
