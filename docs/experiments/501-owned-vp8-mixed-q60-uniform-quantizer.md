# Uniform quantizer for mixed q60 frames

In the signed chroma DC feedback experiment, all original-reference PSNR
rows passed and four raw VP8 size rows exceeded the cap. The first-partition
trace found that segmentation and skip flags together accounted for about
94% of the first-partition excess on rows 75 and 76. This trial targets the
segment map while retaining the chroma DC feedback. See the
[#501 decision log](https://github.com/PiesP/wasm-motion-converter/issues/501).

For the existing mixed low-curvature q60 profile, sort the active
effective quantizer indices and select the median weighted by classified
macroblock counts. Equal indices contribute their combined weight. At an
exact half split, select the lower index. Signal this single base index
with segmentation disabled. The original source classes still determine
the UV AC-tail policy and mode-rate prices. The profile keeps its header
deltas, skip policy and loop filter. This changes the decoder quantizer
outside the median class and may change both reconstruction and token cost.

Screen the signed source and module against the existing frozen tuning and
actual-input conditions before product timing or fresh acceptance. Record
first-partition and total packet bytes separately. Any change to skip flags
or to end-of-block token emission is a separate experiment.
