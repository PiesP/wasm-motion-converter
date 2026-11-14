# Owned VP8 v2 engineering implementation

Execution and acceptance are governed by [issue #501](https://github.com/PiesP/wasm-motion-converter/issues/501)
and the [prospective contract](../../docs/experiments/501-owned-vp8-v2-contract.md).
This crate remains experimental and absent from production delivery. The
historical DC-only result and receipts remain in `497-owned-vp8-result.md`.

The residual path now codes all sixteen coefficients using B_PRED/B_DC prediction,
plus a separately exercised I16/DC and Y2/WHT path. The default experimental
entrypoint now selects bounded I16/I4/UV modes using distortion and estimated
mode/coefficient/skip bit costs. Trials isolate reconstruction and contexts.
Color/preset calibration, filtering, bounded resumable ABI2 and product
qualification are unfinished. q60/75/85 map to exploratory quantizers and do not qualify fidelity
or removal of `wasm-webp`.

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
The rest of this experimental encoder is owned Rust. Retain
[LICENSE.libwebp](LICENSE.libwebp) and [PATENTS.libwebp](PATENTS.libwebp) with source
and eventual binary distributions. Format tables and decoder reconstruction are
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
finalization and assembly. Finalized sizes are admitted before output allocation;
first-partition overflow is separate from total output overflow. Output remains
hidden until arithmetic coding and final assembly finish. The current long-0xff
carry scan still needs bounded continuation, and browser cancellation/resource
qualification is unfinished. These plans and Node/Rust tests do not establish
browser/GPU peak, physical zero-copy or product adoption.

## Engineering checks

Run from this crate with the pinned Rust toolchain:

```sh
cargo test --locked --offline
cargo test --locked --offline -- --ignored
cargo fmt --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo build --locked --offline --release --target wasm32-unknown-unknown
```

Ignored tests explicitly require FFmpeg's native `vp8` and separate `libvpx`
decoders. They compare every visible YUV byte against encoder reconstruction
with filtering disabled, including all modulo-16 remainders and synthetic signed
coefficient categories, zero runs, skips and Y2/B_PRED contexts. They establish
engineering correctness only. They do not measure preset fidelity, product
performance, cancellation or animation/browser acceptance. Forward transform
vectors also use separately executed pinned C arithmetic; that check alone is
not independent codec validation.
