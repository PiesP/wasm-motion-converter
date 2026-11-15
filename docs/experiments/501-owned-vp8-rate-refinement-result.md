# Owned VP8 rate refinement: retained partial results

Issue #501 remains **ACTIVE / PARTIAL**. These fixed-pixel engineering results
do not qualify production adoption. Patched `wasm-webp@0.1.0` remains the
production runtime and primary comparator, with binary SHA256
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
The previous rejected candidates and their thresholds remain unchanged.

## Observed tuning and regression results

The complete known matrix contains 45 tuning conditions plus 45 conditions
from each exposed v1-v4 cohort: 225 fixture/preset conditions, each with its
own PSNR, SSIM and size gates. No average can hide a failed condition.

| Source | Low-preset change | Conditions passing every gate | Retained failure |
| --- | --- | ---: | --- |
| `ca2e35bd` | Selected textured q32 / UV AC -8 point from a prospectively fixed six-point screen | 223/225 | Legacy chroma SSIM; v3 admitted-large size |
| `9f6db557` | Flat q18, UV AC -12 | 221/225 | Initial column/photo, v3 photo and v4 text size; all quality gates pass |
| `2061f46f` | Signaling lambda 11/10 | 221/225 | Initial column, v2/v3 photo and v4 text size; all quality gates pass |
| `c901c052` | UV AC -11, lambda 6/5, unused skip-syntax omission | 224/225 | V4 text q60 size 2,388 > 2,365 bytes; all quality gates pass |
| `efc5bfee` | Fine-smooth q7 | 224/225 | V4 text q60 size 2,385 > 2,365 bytes; all quality gates pass |
| `e749b8f7` | All low Y indices +1, compensating UV deltas | 44/45 tuning | Legacy gradient q60 SSIM 0.944268 < 0.951394; regression cohorts not run |
| `db48401f` | Restore chromatic flat/ramp Y precision | 222/225 | Initial gray PSNR, v2 chroma SSIM and v4 tiny SSIM |

The six-point screen varied low textured q30/q32 and UV AC -8/-12/-15,
keeping UV DC -4 and all other settings fixed. Four points passed its nine
diagnostic conditions, and the predeclared lowest-total-low-preset-byte rule
selected q32/-8. Its later full-matrix failures remain failures.

A separate fixed three-point interpolation from `2061f46f` tested UV AC
-9 (`a4f1d837`), -10 (`55f0636d`) and -11 (`07bd28da`) on nine diagnostic
fixtures at all three presets. The results were 26/27, 25/27 and 26/27;
none was feasible. The -9/-10 points failed legacy chroma SSIM, and -10/-11
failed v4 text size. A diagnostic subset never establishes acceptance.

Raw sources, inputs, WebP outputs, independently decoded RGB, condition JSON,
identity manifests and command logs remain in the retained issue-501 evidence
under `m2-frontier-selected-*`, `m2-rate-balance-24-*`, `m2-rate-price-25-*`,
`uv-ac-refine-*`, `m2-rate-price-26-*`, `m2-rate-smooth-27-*`,
`m2-rate-luma-28-*` and `m2-rate-texture-29-*`. No failed receipt was replaced.
An initial candidate28 Rust check exposed two stale, explicit preset-value
expectations; their failure log is retained. Updating those values preserved
the signed-header, reconstruction and synchronous/ABI2 assertions.

After these rejected trials, `3d2c267d` restores the candidate26 Rust inputs.
Its rebuilt WASM is byte-identical to candidate26:
`57b8a0a93081a051c417ffa632cbc5956057390ad870bd0d99560f63710de341`,
177,782 raw bytes and 36,774 gzip level-9/mtime-0 bytes. The earlier source-bound
225-condition result is reused with its actual tested source `c901c052`;
it is not presented as a new run or a passing acceptance matrix.

## Independently reviewed skip-syntax change

`939e733b` and `b9e2cf2f` integrate the independently implemented
`f1a001ad` / `049e9577` change. After bounded statistics collection, a frame
with exactly zero skipped macroblocks freezes disabled skip syntax: no
probability literal or per-macroblock skip bits. Frames containing any skipped
macroblock retain the prior syntax. Analysis keeps its conservative estimate;
counting and emission share the frozen decision. The first-partition budget
and finalized-output admission remain unchanged.

Fifteen synthetic nonzero controls each saved one actual byte. A compiled
ABI2 2x5 control changed from 64 to 63 bytes, matched synchronous output and
repeated same-instance output, and preserved visible YUV through FFmpeg's
native VP8 and separate libvpx decoders. These controls are not acceptance
fixtures or a universal savings claim. The new optional state fits the existing
8-MiB fixed scratch allowance; exact previous struct padding was not measured.
No physical peak-memory reduction is claimed.

Read-only reviews of the immutable skip change and the production Rust range
`3d379275..c901c052` found no actionable defect. Review does not substitute for
the new candidate's source-bound tests, fresh held-out evaluation or product
qualification. The skip lane's final 75 default and 11 explicit independent-
decoder Rust tests, fmt/Clippy and reproducible-WASM checks passed.

## Next qualifying work

The source-only corrected-v5 freeze has 18 new inputs / 54 conditions and an
independent source review. Its manifest is
`c8929d67d57c6df20e2c152c85ac4178b9b4a4c9c7184892b62df130de8faf83`.
No v5 codec outputs have been generated at this checkpoint. Complete correctable
rate decisions before freezing an exact candidate for the first full evaluation.

Bounded UV coefficient rate/distortion decisions and exact-semantic trial-cost
factorization are independent implementation lanes. Their results must be
reviewed and integrated before making new quality or speed claims. Preserve
unfiltered reconstruction, input/settings identity, deterministic output,
resource ceilings and host-task cancellation. New source requires controlled
evidence; native Canvas output cannot qualify the owned software route.

M4 draft PR #505 still contains an older module and is not qualified for
landing. Whole-product balanced first/warm timing, final-candidate installed-
browser animations, resources and recovery remain separate gates. M5 runtime
and delivered-asset removal remains queued. This result does not close #501.
