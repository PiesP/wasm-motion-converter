# Owned VP8 v2 candidate implementation

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
update flags and literals. The encoder adopts updates only when the complete
frame is strictly smaller; count and emission use the same frozen model.
The bounded resumable ABI2 core is implemented. Color/preset calibration,
filter tuning, and browser/product qualification remain unfinished. q60/75/85 map to exploratory quantizers and do not qualify fidelity
or removal of `wasm-webp`.

Textured allocation uses a per-frame flag that is true only when every imported,
padded U/V sample is exactly 128, accumulated during bounded RGB-to-YUV conversion.
The colored and neutral tables for every quality are canonical in `presets.rs`.
High-input-chroma-loss q60 frames compare original and refined luma profiles
using visible YUV error and frozen modeled rate. One working state is reused;
resets and probability/rate analysis are bounded stages. Strict improvement
selects refinement, otherwise original analysis is retained or reconstructed.
The source import, four segment IDs and resource ceilings are unchanged.
These engineering decisions have no independent product qualification claim.

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

The finest smooth segment also preserves DC precision when all three imported
Y/U/V tile ranges are exactly zero. Smooth colored tiles with a one-level range
retain the separate flat-class rate allocation. This uses bounded per-tile range
scans and the existing four IDs; no geometry-specific rule or extra segment is used.

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
and candidate binary distributions. Format tables and decoder reconstruction are
attributed to the RFC; no external production Cargo crate is used.

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
finalization and assembly. Visible UV refinement retains the mandatory one-edit
choice per macroblock and spends at most 128 additional proposal evaluations per
frame, assigned by uniform per-macroblock quotas. Its private search uses at most
64 directed coefficient moves per macroblock, a two-path beam and four distinct
coefficient positions per path. Each additional proposal takes one bounded ABI
step. Complete trials score the combined U/V reconstruction; the search commits
only a final state with the original skip syntax and coefficient frontier.

Exact byte counting independently evaluates the extended choice, the mandatory
choices captured during the same analysis, and the unrefined records when those
variants differ. After each count, the encoder copies completed reconstruction
into the former source YUV slots, applies the signaled loop filter in raster
order, and scores visible RGB with streaming SSIM moments. With legal unrefined
output, it first finds the best finite score among legal variants no larger than
that output. A legal refined variant exactly one byte larger is eligible only
when its score strictly exceeds that best score. It then selects the highest
finite score among eligible variants; variants two or more bytes larger remain
ineligible. This one-byte admission window does not raise the output or
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
vp run build:vp8-wasm:generate
vp run build:vp8-wasm:check
vp exec node --experimental-strip-types scripts/test/owned-vp8-compiled.ts
```

The provenance manifest includes this README and license files as well as Rust
sources. Regenerate it after changing any listed input, then run `--check`; an
unchanged WASM digest alone does not validate stale provenance.

The artifact is `owned-vp8.wasm` in this crate and participates in the candidate
product import/build graph. It is not yet qualified for master delivery. Its
memory declaration has an exact 192-MiB maximum; raw
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
