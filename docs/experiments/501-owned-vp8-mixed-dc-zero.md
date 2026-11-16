# #501 mixed-profile UV DC-zero candidate

## Changed premise and fixed control

The prior mixed UV DC -9 source `3c6a163c71e9dabe71c962877846fa520eb766d6`
failed the frozen 50-condition exposed screen: 48 rows passed all three gates,
but frame 38 raw VP8 was 33,469 bytes, above 33,402.5 and frame 76 was
12,014 above 10,815 bytes. The separate original-reference frame 76 PSNR was
41.511394 dB versus the shipped primary's 42.701327 dB, a -1.189932 dB
delta below the unchanged -1 dB floor. Its failed results and independently
verified saved streams remain in
`501-owned-vp8-mixed-uv-dc-precision.md` and the private
`mixed-uv-dc-precision-01/quality-preparation` receipts. No rounding bias has
been established: signed quantization is symmetric.

This candidate tests whether existing unit-DC-only UV blocks can be encoded
as zero when their predictor has no greater error against the imported YUV
samples and the frozen-context residual rate is lower. It keeps the prior
source's -9 UV DC delta and all other preset values.

## Single bounded change

Enable the existing `optimize_uv_dc_zero` rule for all segment classes only
when the existing mixed quality-60 profile is active. For textured segments,
first retain the existing AC-tail trial, then test its returned coefficients
and reconstructed patch for DC zero. For other mixed segments, test the
ordinary coefficients and patch. The rule accepts only a unit DC coefficient
with no AC coefficients, non-increasing imported-YUV patch SSE, and strictly
lower estimated residual cost in the current above/left context. It leaves
rejected trials unchanged. Four UV prediction modes still use local trial
state; committed reconstruction and coefficient contexts change only after
mode selection. Fully hidden 4x4 UV patches remain excluded by the existing
visible-sample allowance. No search quota, heap storage, ABI, output limit, profile
classifier, frame cadence, geometry, filter, RGB SSD guard, or baseline
comparator changes.

The imported-YUV patch SSE check is local to one 4x4 block. It does not prove
original-source RGB PSNR, frame-wide decoded quality, encoded size, or product
performance. Later prediction, selected-mode refinement, filter, and entropy
can affect the final result.

## Prospective validation and decision

Check an actual selected unit-DC removal with non-increasing local SSE and
lower frozen-context residual cost, unchanged disabled-profile routing,
isolated trial contexts and hidden patches, sync/resumable consistency, and
native VP8 plus libvpx reconstruction. Run focused native tests, the maintained
Rust/WASM and compiled ABI2 gates, and source-bound asset checks before
measurement. The comparison keeps the 15 frozen tuning IDs at q60/75/85 and
five actual-browser-RGB controls at q60, plus five separate original-source
references. Each applicable row retains PSNR at least primary minus 1 dB,
SSIM at least primary minus 0.01, and raw VP8 bytes at most
`max(1.25 * primary, primary + 128)`. An individual failed row cannot be
averaged away. Preserve first receipts and unchanged thresholds. A passing
diagnostic subset only permits proceeding to the full 77-frame and 687-case
screens, fresh held-out acceptance, actual software-route product performance,
resource and cancellation checks, and delivery qualification.

## Engineering checkpoint

Pinned Rust 1.99.1 formatting/check, the actual DC-zero activation regression,
164 ordinary tests, all 17 explicit independent-decoder/property tests, and
all-targets Clippy with warnings denied pass. Maintained WASM generation,
byte-identical independent rebuild, prebuilt verification and all 48 compiled
ABI2 cases pass. Direct static review found no remaining defect; an independent
fixture specifically combining an AC-tail removal with DC removal was not
added, so the existing individual policy and sync/resumable checks retain
that coverage limit.

The module is `ae9061262e23e19ad3d859425211f6b4ef610a5f09392b8b16d389a56c404d3c`,
246508 raw / 81784 Node gzip level-9 bytes, with unchanged initial
1,114,112 and maximum 201,326,592 linear bytes. All 28 provenance inputs
and the artifact were independently rehashed. Provenance SHA-256:
`f17847f0c9e4b248e32588426d25e2aa2f31bcb444ceb53329142eea4e4a89c7`.

Quality, size, product performance/resource, browser acceptance and delivery
remain NOT_RUN for this point. Freeze a clean signed source and exact module
before the diagnostic screen. Production wasm-webp remains.
