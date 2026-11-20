# Mixed q60 chroma DC feedback

The fixed-stream prefilter diagnostic found that signed U and V error remained
positive before loop filtering on both sampled mixed q60 frames. On the
larger original-reference miss, 99.49% of the filtered red and blue
tile-constant squared-error excess was already present before filtering.
This supports testing a coefficient decision against the existing quality
and size gates. See the [#501 decision log](https://github.com/PiesP/wasm-motion-converter/issues/501).

For each completely visible mixed q60 chroma tile, each predictive UV mode
tries its own 8×8 reconstruction. After reconstructing a 4×4 patch, measure
the signed sum of source minus decoder-equivalent samples. The patch to its
right and the patch below each receive half of this error, expressed in
forward DC units. Sum the incoming errors, divide by four with rounding
toward zero, and cap the correction to one DC quantizer step. The mode's
distortion and token cost use its resulting coefficients and reconstructed
samples. Each plane and mode owns two above sums and one left sum on the
stack. The trial uses the existing scratch allowance and no frame-sized
allocation.

The coefficient experiment draws on the idea of chroma DC error diffusion
in libwebp's `CorrectDCValues`. Its feedback comes from reconstructed
pixel error and the existing integer transform. The error state ends at the
8×8 tile boundary. See [libwebp's encoder source](https://github.com/webmproject/libwebp/blob/6c484cbf92e81a5673b24485ac02d211f69be5b7/src/enc/quant_enc.c),
the [BSD notice](../../crates/owned-vp8/LICENSE.libwebp), and the
[patent grant](../../crates/owned-vp8/PATENTS.libwebp).

Screen the signed implementation and generated module on the frozen tuning
and actual-input rows. On the diagnosed frames, compare prefilter signed
chroma error and the original-reference result. A smaller signed bias alone
is diagnostic. The existing per-row quality and size limits govern whether
to advance to product timing or fresh acceptance.
