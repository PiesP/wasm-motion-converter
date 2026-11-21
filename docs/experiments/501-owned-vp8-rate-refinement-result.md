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

## Bounded UV coefficient decisions and cost reuse

`a0f5768f` integrates the UV coefficient decision from `081fdce3`, and
`057bc7c3` integrates exact-semantic cost factorization from `68ac0e27`.
For q60 UV blocks, the residual trial considers one alternative: remove the
last nonzero scanned AC coefficient when its magnitude is one. DC remains.
The decision compares actual clamped reconstructed-pixel SSE and plane-2 token
cost under isolated local contexts. An alternative needs both lower estimated
rate and lower SSE-times-256 plus lambda-times-rate. Global state changes only
when the macroblock mode wins. The later textured-only restriction retains
nearest coefficients for existing fine-smooth, flat and ramp segments.

Cost factorization caches luma and UV token costs in fixed stack arrays while
preserving per-pair header admission, iteration/tie order and winner-only state
changes. An all-zero pair emits no tokens; a single zero fragment still pays
for its EOB tokens when the other fragment is nonzero. No heap, ABI, preset or
resource ceiling changed. Independent reviews found no actionable defect.

The combined source `057bc7c3` passed 92 Rust tests including 11 independent
decoder tests, fmt/Clippy, compiled ABI2 and reproducible-WASM checks.
`776158aa` then added a test that asserts a real signed unit-AC removal on both
U and V before independently checking visible YUV with native VP8 and libvpx.
That additional test passed; rebuilt executable bytes were unchanged. The
redundant same-emitter byte assertion from the factorization lane was removed;
its differential score/error/selection and trial-isolation assertions remain.

| Candidate | Actual tested source / WASM SHA256 | Complete result |
| --- | --- | --- |
| 30, all q60 segments | `776158aa` / `cf6533d22ef1957d233f338443da141e494c4a65098aa111fcfd8bf1c029bdac` | 44/45 tuning; gradient PSNR 33.096804 < 35.955451 and SSIM 0.885645 < 0.951394; exposed cohorts not run |
| 31, existing TEXTURED segment only | `76654d8a` / `d3547c503f30c690c0e510b0d69a95963bce67940446c4627f19af87af3cb994` | 223/225 known conditions; every size gate passes, two SSIM failures remain |

Candidate31 fails q60 v2 chroma SSIM 0.178890 < 0.180282 and v4 tiny SSIM
0.541997 < 0.549910. Its v4 text is 2,290 bytes against the unchanged
2,365-byte ceiling, versus candidate26's 2,388 bytes. Candidate31's artifact is
179,536 raw / 37,371 gzip bytes with unchanged 192-MiB linear maximum. This
is an observed rate improvement on that control, not an adoption result.
All raw outcomes remain under `m2-uv-rdo-30-*` and
`m2-uv-texture-rdo-31-*`. Further work should inspect selected residual changes
and actual distortion before another prospective correction.

## Visible coefficient price and first v5 evaluation

Source `187dd82e` separates the coefficient price from macroblock mode cost:
divide by 64 for a full UV patch and scale by its visible sample count out of
16. Padding-only patches retain nearest coefficients. The copied source-bound
candidate31 trace showed that its previous price accepted all eligible chroma
proposals; the new formula was fixed prospectively before measurements. It
does not select an exception by fixture or dimensions.

The corrected source passed all 225 known conditions, full Rust 94/94 including
12 independent-decoder tests, fmt/Clippy, compiled ABI2, reproducible WASM and
maintained verify 9/9. Its module is
`cc08cc7dba6c8325581d765e058c91b6886c9b77bf482822921db70b2d2090cf`,
179,706 raw / 37,500 gzip bytes. A tiny boundary regression matches the retained
pre-RDO 86-byte payload and synchronous/ABI2 execution. Independent source review
found no actionable defect.

Freeze source `6b1f848b` then ran the first complete v5 evaluation: 50/54 pass,
with two q60 SSIM and two q75/q85 large-size failures. See the
[retained rejected result](501-owned-vp8-v5-result.md). Every candidate frame
independently decodes to the same YUV through native VP8 and libvpx; all duplicate
input/preset groups are deterministic. Those correctness observations do not
override the four quality/size failures.

## Next qualifying work

The source-only corrected-v5 freeze has 18 new inputs / 54 conditions and an
independent source review. Its manifest is
`c8929d67d57c6df20e2c152c85ac4178b9b4a4c9c7184892b62df130de8faf83`.
Its first evaluation is now exposed and regression-only. Subsequent input-loss
UV calibration and flat-UV DC tie reduction passed all 279 known conditions.
The [v6 candidate freeze](501-owned-vp8-v6-candidate-freeze.md) then evaluated
54 fresh conditions and passed 53, with one q60 chroma SSIM failure; see
[the retained result](501-owned-vp8-v6-result.md). That remaining precision
failure motivated the content-dependent luma work below. Preserve the frozen
cohorts and every outcome under the [current contract](501-owned-vp8-v2-contract.md).

Bounded UV coefficient rate/distortion decisions and exact-semantic trial-cost
factorization are now integrated engineering changes. A bounded content-dependent
luma profile preview subsequently passed all 333 known conditions; its
[prospective v7 freeze](501-owned-vp8-v7-candidate-freeze.md) records actual
source/module identities and unchanged fresh gates. Its first evaluation passed
51/54, with three new tiny-input SSIM failures at q60/75/85; see
[the rejected result](501-owned-vp8-v7-result.md). V1–V7 became regression-only at that decision. The known matrix then
contained 387 conditions, and no successor had been frozen. Preserve
unfiltered reconstruction, input/settings identity, deterministic output,
resource ceilings and host-task cancellation. New source requires controlled
evidence; native Canvas output cannot qualify the owned software route.

M4 draft PR #505 still contains an older module and is not qualified for
landing. Whole-product balanced first/warm timing, final-candidate installed-
browser animations, resources and recovery remain separate gates. M5 runtime
and delivered-asset removal remains queued. This result does not close #501.
