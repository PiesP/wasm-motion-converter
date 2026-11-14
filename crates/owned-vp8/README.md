# Owned VP8 v2 engineering implementation

Execution and acceptance are governed by [issue #501](https://github.com/PiesP/wasm-motion-converter/issues/501)
and the [prospective contract](../../docs/experiments/501-owned-vp8-v2-contract.md).
This crate remains experimental and absent from production delivery. The
historical DC-only result and receipts remain in `497-owned-vp8-result.md`.

The residual path now codes all sixteen coefficients using B_PRED/B_DC prediction,
plus a separately exercised I16/DC and Y2/WHT path. The default experimental
entrypoint still selects B_PRED. Rate-distortion mode search, color/preset
calibration, filtering, bounded resumable ABI2 and product qualification are
unfinished. q60/75/85 map to exploratory quantizers and do not qualify fidelity
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

The v1 ABI accepts one copied input reservation and publishes a borrowed output
until reset or the next reservation, including a failed reservation. A caller
must refresh JS views after any WASM growth, copy the output before reuse, and
keep one conversion per instance. Return codes are 0 success, 1 invalid input,
2 unsupported pixels (nonopaque input), and 3 output limit. Input is bounded to
2048 pixels on each axis, 4,194,304 pixels total, and 16 MiB. Output is bounded
to 4 MiB. This crate has no external Cargo dependencies.

At the experimental maximum, copied input and six padded YUV planes account
for 16 MiB and 12 MiB. Dense macroblock records now retain 24 full 16-coefficient
blocks plus Y2 and mode state per macroblock; this is larger than the historical
DC-only record. Two partitions may retain up to 8 MiB and final assembly up to
4 MiB concurrently. These are payload bounds, not allocator/linear capacity or
browser/GPU peak. ABI2 must prospectively plan all simultaneous capacities and
host copies under the unchanged product ceilings before production admission.
The prototype geometry/output caps are not the product supported-input contract.

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
