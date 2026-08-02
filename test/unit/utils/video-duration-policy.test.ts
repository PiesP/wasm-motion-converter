// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

import { WEBP_MAX_DURATION_MS, WEBP_MAX_FRAMES } from '@utils/constants';
import { assessVideoDuration, estimateFrameCount } from '@utils/video-duration-policy';
import { describe, expect, it } from 'vitest';

describe('video duration policy', () => {
  it('estimates frames with the provided FPS and rounds up', () => {
    expect(estimateFrameCount(5000, 24)).toBe(120);
    expect(estimateFrameCount(101, 10)).toBe(2);
  });

  it('allows WebP values exactly at both safety limits', () => {
    expect(assessVideoDuration(WEBP_MAX_DURATION_MS, 'webp', 10)).toEqual({
      valid: true,
      duration: WEBP_MAX_DURATION_MS,
      estimatedFrames: WEBP_MAX_FRAMES,
      warnings: [],
    });
  });

  it('reports duration and frame-count warnings independently', () => {
    const durationWarning = assessVideoDuration(WEBP_MAX_DURATION_MS + 1, 'webp', 1);
    expect(durationWarning.warnings).toHaveLength(1);
    expect(durationWarning.warnings[0]?.message).toContain('duration');

    const frameWarning = assessVideoDuration(300_001, 'webp', 30);
    expect(frameWarning.warnings).toHaveLength(1);
    expect(frameWarning.warnings[0]?.message).toContain('frame count');
  });

  it('does not apply WebP safety warnings to GIF output', () => {
    expect(assessVideoDuration(WEBP_MAX_DURATION_MS * 2, 'gif', 60).warnings).toEqual([]);
  });
});
