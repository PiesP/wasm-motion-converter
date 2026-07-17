// SPDX-License-Identifier: MIT
// Copyright (c) 2025 PiesP
//
// Coverage gap analysis — documents what IS and IS NOT tested.
// This file is documentation only, not a test.

/**
 * Test Coverage Matrix
 * ====================
 *
 * Video Files Available (7):
 *   - h264-baseline, h264-main, h264-high (H.264 profiles)
 *   - hevc (HEVC Main)
 *   - vp8 (VP8)
 *   - vp9 (VP9 Profile 0)
 *   - av1 (AV1 Main)
 *
 * All files: 1920×1080, 9.75s, 60fps
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    CURRENT COVERAGE                                 │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │ smoke.spec.ts                                                       │
 * │   ✅ H.264 Baseline → GIF (50%, medium)                            │
 * │   ✅ H.264 Baseline → WebP (50%, medium)                           │
 * │   ✅ HEVC → GIF (50%, medium)                                       │
 * │   ✅ VP8 → GIF (50%, medium)                                        │
 * │   ✅ AV1 → GIF (50%, medium)                                        │
 * │   ✅ Unsupported file → error                                       │
 * │   ✅ Progress increases during conversion                           │
 * │                                                                     │
 * │ matrix.spec.ts                                                      │
 * │   ✅ All 7 codecs → GIF (50%, medium)                              │
 * │   ✅ All 7 codecs → WebP (50%, medium)                             │
 * │   ✅ Output size regression check (maxBytes × 1.5)                 │
 * │                                                                     │
 * │ regression.spec.ts                                                  │
 * │   ✅ Size regression (vs baseline)                                  │
 * │   ✅ Timing regression (vs baseline)                                │
 * │   ✅ New failure detection                                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    COVERAGE GAPS                                    │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │                                                                     │
 *  │ QUALITY VARIATIONS (not tested)                                    │
 * │   ❌ low quality → all codecs                                       │
 * │   ❌ high quality → all codecs                                      │
 * │   ❌ Quality affects output size (low < medium < high)             │
 * │                                                                     │
 * │ SCALE VARIATIONS (not tested)                                       │
 * │   ❌ 75% scale → all codecs                                         │
 * │   ❌ 100% scale → all codecs                                        │
 * │   ❌ Scale affects output size (50% < 75% < 100%)                  │
 * │                                                                     │
 * │ TRIM (not tested)                                                   │
 * │   ❌ Trim to N seconds                                              │
 * │   ❌ Trim reduces output size / duration                            │
 * │                                                                     │
 * │ H.264 PROFILE DIFFERENCES (not tested)                              │
 * │   ❌ Baseline vs Main vs High → same format output                 │
 * │   ❌ Profile affects conversion path selection                      │
 * │                                                                     │
 * │ OUTPUT VALIDATION (partially tested)                                │
 * │   ✅ GIF structure validation (via verify.ts)                       │
 * │   ✅ WebP structure validation (via verify.ts)                      │
 * │   ❌ Output dimensions match settings                               │
 * │   ❌ Output frame count reasonableness                              │
 * │                                                                     │
 * │ ERROR SCENARIOS (partially tested)                                  │
 * │   ✅ Unsupported file type                                          │
 * │   ❌ Corrupt video file                                             │
 * │   ❌ Empty file                                                     │
 * │   ❌ Oversized file (>500MB)                                        │
 * │                                                                     │
 * │ CANCELLATION (not tested)                                           │
 * │   ❌ Cancel during conversion                                       │
 * │   ❌ Cancel during software decode (AV1 path)                       │
 * │                                                                     │
 * │ UI STATE (partially tested)                                         │
 * │   ✅ Progress bar visible during conversion                         │
 * │   ✅ Download button visible after completion                       │
 * │   ❌ Memory warning for large files                                 │
 * │   ❌ Trim selector enabled after file load                          │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                    RECOMMENDATIONS                                  │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │                                                                     │
 * │ HIGH priority (blocks release):                                     │
 *  │   1. Quality variations: low/medium/high for H.264 Baseline        │
 * │   2. Scale variations: 50%/75%/100% for H.264 Baseline              │
 * │   3. Trim functionality                                             │
 * │   4. H.264 profile comparison (baseline vs main vs high)            │
 * │                                                                     │
 * │ MEDIUM priority (catches regressions):                              │
 * │   5. Output dimension/frame validation                              │
 * │   6. Error scenarios (corrupt/empty/oversized)                      │
 * │   7. Cancellation flow                                              │
 * │                                                                     │
 * │ LOW priority (nice to have):                                        │
 * │   8. Memory warning UI                                              │
 * │   9. Trim selector state                                            │
 * └─────────────────────────────────────────────────────────────────────┘
 */

export const COVERAGE_DOCUMENTATION = true;
