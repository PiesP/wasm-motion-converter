# Owned VP8 v2 candidate implementation

The [combined M2 and strict compiler candidate](../../docs/experiments/501-owned-vp8-combined-m2-simd-candidate.md)
combines the qualified exposed Y1 source with exact paired chroma sampling and
strict compiler SIMD permission. At signed source
`e0211406bff52db7258b0679c3698fb083971df0`, its generated and checked
module is `bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e`.
The combined candidate passed direct 20-condition and full 687-condition raw
VP8 identity against the immediate scalar Y1 control. The 687 new encodings
reuse the scalar Y1 decoder and metric evidence only after all raw payloads
matched; no new VP8 decode, metric score, or primary wasm-webp reencode was run.
The independent audit and Node-only timing results are recorded in the
[combined candidate result](../../docs/experiments/501-owned-vp8-combined-m2-simd-candidate.md).
Separate component timing ratios must not be multiplied. Browser capability,
product performance, physical resource peaks, and delivery remain unqualified.
Changes to this README require a provenance refresh before prebuilt verification.

Execution and acceptance are governed by [issue #501](https://github.com/PiesP/wasm-motion-converter/issues/501)
and the [prospective contract](../../docs/experiments/501-owned-vp8-v2-contract.md).
The candidate main and conversion Worker software routes import this crate's
WASM artifact. Master delivery and `wasm-webp` removal remain gated by product
qualification. The historical DC-only result and receipts remain in
`497-owned-vp8-result.md`.

The residual path now codes all sixteen coefficients using B_PRED/B_DC prediction,
plus a separately exercised I16/DC and Y2/WHT path. The candidate encoder
selects bounded I16/I4/UV modes using distortion and estimated
mode/coefficient/skip bit costs. Trials isolate reconstruction and contexts.
Per-frame coefficient statistics follow frozen mode/coefficient decisions. A
bounded optimizer proposes updates, and exact whole-frame counting includes
update flags and literals. The encoder uses the proposed model when its first partition fits and either
the default first partition exceeds the limit or the complete frame shrinks.
Counting and emission use the same frozen model.
The bounded resumable ABI2 core is implemented. The earlier low-curvature module
`e918f3016451b60f04dfa551e5ae57820bcbc65c8c8834f01c8426b72355e584`
passed 627 exposed and 60 first-V12 fixed-pixel quality/size conditions, as
recorded in its [source-bound result](../../docs/experiments/501-owned-vp8-low-curvature-result.md).
The [mixed Y1 AC allocation control](../../docs/experiments/501-owned-vp8-mixed-y1-ac-allocation-candidate.md)
failed one of its 50 codec quality/size screen conditions. The
[I4 AC-tail RDO candidate](../../docs/experiments/501-owned-vp8-i4-ac-tail-rdo-candidate.md)
passed 47 of 50 conditions; three actual-browser-RGB rows failed PSNR. The
[half-weight I4 AC-tail trial](../../docs/experiments/501-owned-vp8-i4-ac-tail-half-lambda-candidate.md)
also passed 47 of 50; actual rows 19, 38, and 57 failed PSNR. None of these
points qualifies this module or runtime removal of `wasm-webp`. Product
acceptance remains unrun.
The [I4 AC-tail source-Y SSD guard](../../docs/experiments/501-owned-vp8-i4-ac-tail-ssd-guard-candidate.md)
adds a no-increase source-Y patch SSD condition to the half-weight trial.
It passed 49 of 50 frozen codec conditions: all actual rows passed PSNR and
RGB SSIM, but row 38 exceeded the raw VP8 size limit. This point is rejected
for adoption; the full exposed and product gates remain unrun. Its measured
module is source-bound to `b5b9e8aa`; README edits require a provenance
refresh before the current checkout's manifest can be treated as verified.
The [10% I4 AC-tail source-Y SSD budget](../../docs/experiments/501-owned-vp8-i4-ac-tail-ssd-budget-candidate.md)
allows a bounded local SSD increase while retaining the strict rate and
half-weight RD checks. It passed 49 of 50 frozen codec conditions: all actual
rows passed PSNR and RGB SSIM, but row 38 exceeded the raw VP8 size limit.
The saved 45-condition paired decoder audit passed. This point is rejected
for adoption; full exposed and product gates remain unrun. Its measured
module is source-bound to `a4dfd228`; README edits
require a provenance refresh before the current checkout's manifest can be
treated as verified.
The [selected-mode AC-neighbor candidate](../../docs/experiments/501-owned-vp8-i4-selected-ac-neighbor-candidate.md)
first selects each I4 prediction mode with the original full-lambda search.
Only the winning mode then tries up to 15 independent one-level AC reductions
under the same 10% SSD, strict rate, and half-lambda RD guards. Its signed
measured source `fece0674` and module
`206cf945b56ca26d1cb11d1636cb80a4a623036691a8a6d901c41bd79910f223`
passed 49 of 50 frozen codec conditions: all actual PSNR and RGB SSIM rows
passed, but actual row 38 exceeded the raw VP8 size cap by 1,069.5 bytes.
This point is rejected; the full exposed and product gates remain unrun.
This README result update requires a provenance refresh before the current
checkout's manifest can be treated as verified.
The [eligible Y1 AC zero-bin candidate](../../docs/experiments/501-owned-vp8-y1-ac-zero-bin-candidate.md)
adds one fixed encoder-side `5/8` zero threshold only for marginal Y1 AC
levels in the existing mixed q60 profile. Canonical nearest quantization and
all signaled decoder steps remain unchanged elsewhere. Its signed measured
source `1e80f53b` and module
`fc13fa5fcc7b07a7922e64489220d9e1073588947216d3dba9fbca498eb64347`
passed the frozen 50-condition screen, the 45-condition paired decoder audit,
and the 687-condition exposed regression (45 current rows reused, 642 newly
run). This is exposed codec evidence only; fresh media, full animation,
physical resource, browser product, performance, and delivery gates remain
open. The patched `wasm-webp` runtime stays primary pending qualification.

The release profile uses `opt-level = 3` as a throughput candidate. The
[one-variable control](../../docs/experiments/501-owned-vp8-throughput-profile.md)
defines the comparison with the retained `opt-level = "s"` module. This build
setting alone does not establish faster conversion or product acceptance.

I4 mode selection applies a mode-only lower bound before reconstruction and a
distortion lower bound before residual counting, skipping modes that cannot
replace the current winner. The mode order and strict tie rule are unchanged.
The selected-mode AC search starts only after that winner is fixed; its chosen
patch is committed before later I4 predictions. An exhaustive test-only search
checks selected modes, coefficients, reconstruction and score. The [prospective experiment and
source-bound result](../../docs/experiments/501-owned-vp8-exact-rdo-pruning.md)
define the original module control, byte comparisons and performance limits.

Textured allocation uses a per-frame flag that is true only when every imported,
padded U/V sample is exactly 128, accumulated during bounded RGB-to-YUV conversion.
The current exploratory colored and neutral qindices are defined in `src/presets.rs`.
The neutral allocation preserves the earlier grayscale control. Per-preset
fixed-pixel results against the shipped baseline are recorded in the linked
source-bound result; product performance and lifecycle gates remain open.
Source color conversion and the four classifier IDs are unchanged.

For normal q60 frames with non-neutral imported chroma and exclusively Textured
source macroblocks, the photo allocation also requires each imported padded Y/U/V
plane's frame mean absolute within-tile second difference to be at most 2. The
classifier retains its separate maximum-curvature rule and four class IDs. The
mean uses 448 Y and 96 U/V differences per macroblock, excludes tile boundaries,
and is accumulated during source classification. Eligible frames lower the coding base and all segment
qindices by four. It signals Y1 DC, Y2 DC and Y2 AC deltas of +4 and UV DC/AC
deltas of -15/-7. The original qindices remain the mode-rate reference. Y1 AC
also becomes finer because VP8 has no separate Y1 AC delta. Neutral, mixed-map
and high-chroma-loss q60 frames, or frames above the per-plane mean cutoff,
do not receive this photo allocation. Padded edge replication can dilute
the measured mean for narrow or odd inputs.

Eligible mixed low-curvature q60 frames use one wire quantizer when the
estimated segment ID map exceeds 128 bytes or when both FineSmooth and
ChromaticFlat are present and no other source class occurs. The smooth pair
can over-allocate residuals even when its map is cheap. The encoder takes the
lower weighted median of the indices shifted by four, floors it at the
unshifted q60 chromatic-ramp index, and omits the map. Other eligible frames
retain the shifted class quantizers. The map estimate uses the existing map
probabilities and macroblock counts and excludes the frame header and
arithmetic termination. The classifier IDs determine the
original rate prices and UV AC-tail eligibility in both cases. On fully
visible chroma tiles, each UV mode uses bounded DC error feedback inside the
8×8 tile. Both paths use full I16/I4/UV analysis without display-based chroma
refinement or its extra search quota.

The estimate uses the fixed quality contract's 128-byte absolute allowance
as the cutoff. It does not change the external size gate. The three failed
exposed rows enter the diagnostic first, followed by the frozen 45 tuning
and seven actual-input conditions if those rows pass. Any small-screen
failure rejects the candidate. The complete exposed matrix and whole-product
timing require separate evidence.
See the [uniform quantizer experiment](../../docs/experiments/501-owned-vp8-mixed-q60-uniform-quantizer.md)
and [chroma DC feedback experiment](../../docs/experiments/501-owned-vp8-chroma-dc-feedback.md).

The segmented mixed q60 branch can emit one wire ID for two occupied
decoder-equivalent classes. It maps Texture (3) to ChromaticRamp (2) only
when their absolute qindices and filter levels agree. Source-class IDs,
rate policies, original map eligibility and analyzed macroblocks stay intact.
The wire header recomputes the three probabilities from the merged counts
and omits the now-unused segment 3 quantizer and filter fields. Remaining
segment features keep the established absolute syntax.

The original decision and its legality are established before counting the
alias. The selected coefficient model, skip syntax, context and token
partition are reused. A bounded header-only arithmetic replay uses the
existing counter and mode rows, at most 64 model entries or one macroblock
per ABI2 step. The alias is emitted only when its actual first partition
shrinks. The frame and output-copy sizes then reflect the smaller packet
within the original reserved linear capacity. The additional configuration
is charged within the fixed engine scratch bound. The frame needs no
additional pixel pass or frame buffer.

At q60, the existing source-derived high-chroma-loss predicate compares the
Original and Reduced profiles. Each completed trial is filtered after its
analysis and rate statistics are finished. Its visible owned-renderer RGB
squared error is multiplied by 256 and added to the existing block and header
rate terms weighted with Original qindices; exact ties retain Original. This is
a prospective change of distortion domain and effective rate balance. Source
YUV remains live through both trials and the final selected-profile analysis.
The filtered trial reconstruction is discarded through the bounded reset, and
that third analysis restores the selected unfiltered records and prediction
state before counting or emission. The ABI reports distinct Original and
Reduced filter/RGB stages and charges one filter macroblock or at most 1,024
RGB pixels per step without another full-frame buffer. This policy
does not change ordinary filtered-SSIM refinement or qualify product fidelity.

With wire segmentation, the finest smooth segment preserves DC precision
when all three imported Y/U/V tile ranges are exactly zero. Smooth colored
tiles with a one-level range retain the separate flat-class rate allocation.
The classifier uses bounded per-tile range scans and the existing four IDs.

The bitstream and coefficient update probabilities follow [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386.html),
sections 7, 9 and 11. The coefficient-update, default-coefficient and DC-quantizer
tables are format constants from sections 13.4, 13.5 and 14.1 respectively;
their Rust files identify those sources separately. RFC 6386 is Copyright (c)
2011 IETF Trust and the identified contributors. These numeric format tables
are not an imported encoder implementation. Original Rust portions use MIT.
The [W3C VP8 WebCodecs registration](https://www.w3.org/TR/webcodecs-vp8-codec-registration/)
defines raw `EncodedVideoChunk` keyframe bytes; browser support must be probed.

Forward DCT/WHT arithmetic is adapted from pinned libwebp v1.3.2
`src/dsp/enc.c`; it is not represented as independently originated arithmetic.
The color import coefficients and gamma tables in `src/color.rs` derive from
libwebp commit `6c484cbf92e81a5673b24485ac02d211f69be5b7`, a diagnostic source
counterpart of the published wrapper tag. Its native import oracle does not prove
the shipped comparator WASM was built from that commit. The encoder implementation
remains owned Rust; these adapted arithmetic/table portions retain attribution. Retain
[LICENSE.libwebp](LICENSE.libwebp) and [PATENTS.libwebp](PATENTS.libwebp) with source
and eventual binary distributions. Format tables and decoder reconstruction are
attributed to the RFC; no external production Cargo crate is used.

The q75 engineering calibration applies only when every admitted macroblock is
Textured and the visible source RGB error from nearest-chroma import is at most
4,096 per channel. It lowers every base and segment luma qindex by two, including
unused classes and neutral inputs. UV DC and AC deltas increase by two so scalar
UV quantizer steps remain unchanged for neutral inputs, including clamping. For
non-neutral inputs satisfying that same policy, UV DC delta then decreases by
four, to -11; UV AC remains -7. Mode and coefficient rate weights use original
qindices. The all-Textured condition is separate from the mixed-map q75
experiments below.
Mode choices and UV reconstruction may still change. The condition reuses the
q60 import-error reference and does not change q85, geometry, cadence or
acceptance thresholds. The [fixed-pixel result](../../docs/experiments/501-owned-vp8-low-curvature-result.md)
binds the compiled artifact, exposed regressions and first V12 cohort. Full
product and delivery gates remain required before adoption.

## ABI2 and resources

The module exports only `vp8_v2_*`; ABI1 FFI exports are retired. The synchronous
Rust helpers remain engineering references with their historical prototype bounds
and are not the ABI2 execution route. `src/abi.rs` defines the twelve-word request,
twenty-four-word response and ticket/lease state machine. `src/limits.rs` defines
status values, geometry, checked byte plans and aggregate admission.

Use plan -> bounded reserve steps -> input lease -> begin -> bounded encode steps
-> output lease -> release. `begin` acknowledges that the physical input write
settled. Abort/retire invalidates publication but retains pending leased storage
until explicit release. A stale or unsuccessful operation publishes no pointer.
Each conversion owns one instance, reused for its frames; compiled code may be
cached separately. Retired/trapped instances are never reused.

ABI2 accepts checked RGBA/BGRA/RGBX/BGRX and packed RGB, including padded stride.
Only visible alpha bytes in alpha-bearing layouts must be opaque. It supports
VP8's 16383-axis and current 10066329-pixel product bounds subject to prospective
memory admission. The prototype's 2048-axis and 4-MiB output limits are not ABI2
limits. Keep 512 MiB aggregate, 128 MiB demux reserve, 192 MiB external frame and
owned-linear ceilings, and 96 MiB output policy. Plans charge linear capacity
once, including inner slots, plus external host bytes and final output copy.
Retained instance pages remain charged between frames. Allocator reservation
capacity can exceed logical input length and must be admitted explicitly.

`FrameEncoder` in `src/textured.rs` stages initialization, color import,
macroblock analysis, exact partition-length counting, frozen-decision emission,
finalization and assembly. Eligible frames with display-based UV refinement
retain a one-edit choice per macroblock and spend at most 128 additional
proposal evaluations per frame, assigned by uniform per-macroblock quotas.
The private search uses at most 64 directed coefficient moves per macroblock,
a two-path beam and four distinct coefficient positions per path. Each
additional proposal takes one bounded ABI step. Complete trials score the
combined U/V reconstruction. The search commits only a final state with the
original skip syntax and coefficient frontier.

For q75 and q85, the higher-preset speed experiment omits the local display
refinement and its extra quota when imported chroma is non-neutral and the
enabled segment ID map costs more than the same 128-byte estimate. The encoder
evaluates the estimate once per frame from the original map probabilities and
four class counts, after classification. The display policy governs the search.
The q75 trials below govern quantization and map signaling for a subset of
those frames. Monochrome, one-class and at-or-below-budget maps retain the full
search. With no refinement edits the encoder follows the single-variant
counting and emission path.

This quality-changing hypothesis targets the macroblock analysis cost observed
in the whole-job medium-preset comparison. It needs the unchanged 687-condition,
frame-level and whole-product gates before adoption.

A separate q75 experiment applies the existing tile-local UV DC error feedback
to those non-neutral, expensive mixed-map frames only when the existing padded
mean curvature test passes on all three source planes. The encoder accumulates
those totals during its existing classification traversal. Each non-neutral
q75 macroblock adds 448 Y and 96 differences for each of U and V to the
existing accumulators. One frame-local boolean retains the policy within the
engine scratch bound. As at q60, feedback applies inside each UV mode trial on
full visible 8×8 chroma tiles.
The first q75 feedback experiment isolated the effect of that tile-local
correction on original-reference PSNR.

The q75 rate experiment applies to the same mixed low-curvature profile.
The first rate point raised the four segment qindices by four and compensated
with deltas of −4 for Y1 DC and Y2 DC/AC and −13 for UV DC/AC. The current
trial keeps those deltas and uses the lower weighted median of the raised
indices, weighted by the original class counts and floored at the q75 chromatic
ramp index of 27. This base index supplies the quantizer for every macroblock.
The frame disables VP8 segmentation and retains the frame filter, tile-local
UV DC feedback, and normal skip and selection rules. Each source class still
uses its original qindex for mode and coefficient rate weighting. The existing
frame-local flags and scratch bound cover the trial. Its common quantizer
changes effective luma and chroma steps, so the frozen frame quality and size
gates apply.

Exact byte counting independently evaluates the extended choice, the mandatory
choices captured during the same analysis, and the unrefined records when those
variants differ. After each count, the encoder copies completed reconstruction
into the former source YUV slots, applies the signaled loop filter in raster
order, and scores visible RGB with streaming SSIM moments. With legal unrefined
output, it first finds the best finite score among legal variants whose
word-aligned RIFF payload cost is no greater than that output's cost. A legal
refined variant costing exactly one additional two-byte RIFF word is eligible
only when its score strictly exceeds that best score. It then selects the
highest finite score among eligible variants; larger aligned costs remain
ineligible. Alignment uses widened arithmetic and includes the odd-byte padding
required by the existing animation mux. This admission window does not raise the output or
partition safety limits. If unrefined output is illegal, it selects the highest
finite score among legal refined variants or returns the unrefined limit error.
Exact score ties prefer extended, then captured mandatory, then unrefined. The RGB view
approximates decoder conversion and cannot replace external quality gates.
A bounded coefficient log and
captured-choice overrides reverse and reapply reconstruction between counts;
the unfiltered reconstruction remains intact for replay. One macroblock of
filtering, 64 KiB of copying, or 64 four-by-four metric blocks run per ABI step.
The two-row moment cache is capped at 1 MiB inside the unchanged 8 MiB scratch
charge and releases at most 64 KiB per step. Metadata is released before the
single output allocation. Finalized sizes
are published at a separate preparation barrier after selection, so the host
can reserve the new plan before advancing;
first-partition overflow is separate from total output overflow. Output remains
hidden until arithmetic coding and final assembly finish. Carry scans and finalization resume in bounded units; emission retains at most
8192 two-byte operations per partition for one macroblock, drains at most 1024
symbols and 64 KiB of carry per step, and then yields through its host. Browser
cancellation/resource qualification is unfinished. These plans and Node/Rust tests do not establish
browser/GPU peak, physical zero-copy or product adoption.

Macroblock mode selection reserves the worst-case remaining I16 header syntax,
all possible coefficient-update literals, and the arithmetic tail against VP8's
first-partition limit. I4 remains eligible while its exact syntax fits that
reserve; final byte counting still checks both partitions before allocation.
This conservative bound may favor I16 on large, complex frames and does not
establish their quality or timing acceptance.

## Engineering checks

Run from this crate with the pinned Rust toolchain:

```sh
cargo test --locked --offline
cargo test --locked --offline -- --ignored
cargo fmt --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo build --locked --offline --release --target wasm32-unknown-unknown
```

From the repository root, use the project-selected Node to generate or verify
the bounded candidate artifact and its source provenance:

```sh
vp exec node --experimental-strip-types scripts/build/build-owned-vp8-wasm.ts --generate
vp exec node --experimental-strip-types scripts/build/build-owned-vp8-wasm.ts --check
vp exec node --experimental-strip-types scripts/test/owned-vp8-compiled.ts
```

The provenance manifest includes this README and license files as well as Rust
sources. Regenerate it after changing any listed input, then run `--check`; an
unchanged WASM digest alone does not validate stale provenance.

The artifact is `owned-vp8.wasm` in this crate, imported by the candidate main
and conversion Worker software routes. Master delivery remains gated by product
qualification. Its memory declaration has an exact 192-MiB maximum; raw
Cargo development output without that declaration does not qualify delivery.

Ignored tests explicitly require FFmpeg's native `vp8` and separate `libvpx`
decoders. They compare every visible YUV byte against encoder reconstruction
with explicit disabled and enabled filtering cases, including modulo-16
remainders, synthetic signed coefficient categories, zero runs, skips and
Y2/B_PRED contexts. They establish
engineering correctness only. They do not measure preset fidelity, product
performance, cancellation or animation/browser acceptance. Forward transform
vectors also use separately executed pinned C arithmetic; that check alone is
not independent codec validation.
