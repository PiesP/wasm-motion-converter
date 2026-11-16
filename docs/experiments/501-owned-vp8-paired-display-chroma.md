# Owned VP8 paired display chroma candidate

Related issue: [#501](https://github.com/PiesP/wasm-motion-converter/issues/501).
Status: built engineering candidate. The local Rust and compiled ABI2 checks
below passed. No exposed/held-out codec equality campaign, timing result,
browser acceptance, or physical resource peak is recorded here.

## Source-bound reason for this trial

The control is source commit `b9b7e8939cf6139db6db778d11f2519567fe61c2`
and its 243,208-byte stripped WASM module SHA-256
`f962b9e803a014febc96d9a59bbab8faeb032866e837136c6afd8dd972fc4186`.
The retained single-frame Node CPU profile is the local receipt
`wmc-501-vp8-v2/cpu-profile-f962-01/run01/raw.cpuprofile`
(SHA-256 `17e04e8534f2e498b32bc8b0ea002135950da5da64738ceddd4ddc428aaa6f80`).
One warm and one profiled ABI2 encode of the same 1920x1080 RGB frame each
produced the original 40,626-byte VP8 frame, SHA-256
`38f4d61fe4fe8b36883b4643da9429afca3afb14e622eab781d7ec5e7922aa3a`.
The profile contains 664 samples, including 599 WASM-labeled samples. An
independently built diagnostic module proved all nine non-custom WASM sections
byte-equal to the stripped control. Function indices and offsets were checked
against the original module before diagnostic names were joined to the profile.
The mapped `Frame::chroma_sum` has 56 self samples / 62,481 sampled microseconds;
`CompleteFrame::chroma_sum` has 13 / 14,451. These are function-level samples
from one Node frame. Inlining, source lines, whole-product cost, and speedup
cannot be inferred from them.

At this source revision, `display_rgb.rs` walks the same horizontal and vertical
display taps once for U and again for V in both `LocalCache::new` and
`CompleteFrame::rendered`. The frame walk also repeats current-tile, committed
neighbor, or future-source selection. The one-variable trial pairs those two
baseline sums in a common row-major tap loop and selects the two UV bytes through
one ownership decision. Only the case with one tap on each axis and both
weights equal to 4096 uses the direct `sample << 24` result. Every other case
keeps each plane's original signed multiplication order and accumulation order.

## Invariants and engineering checks

The old scalar Frame UV and chroma walks remain independent test-only references;
the test-only `Frame::rendered` still uses them. `CompleteFrame` retains a direct
scalar rendered reference for tests. Tests compare both sums, RGB bytes, complete
quality score bits, cached patch score bits, and joint tile score bits. Fixtures
include signed one- through four-tap axes, nonstandard single-tap weights, edge
clamps, tiny and odd/even visible dimensions, all source layouts, and distinct
source, reconstructed, and current macroblock UV. Existing frozen FFmpeg display
controls and local/complete cache bounds remain in the crate tests.

No import color policy, chroma sampling policy, trial patch replacement, scoring
expression, mode decision, preset, ABI, cadence, route, resource ceiling, or
dependency changes are part of this trial. The paired helper uses only a tuple
and scalar stack locals; it adds no persistent allocation.

The local checks ran from `crates/owned-vp8` with the pinned Rust toolchain,
starting with the focused tests:

```sh
cargo fmt
cargo fmt --check
cargo test --locked --offline display_rgb::tests
cargo test --locked --offline
cargo test --locked --offline -- --ignored
cargo clippy --locked --offline --all-targets -- -D warnings
```

The source-bound WASM provenance was generated and checked, then the actual
compiled ABI2 checks ran from the repository root under the project-selected Node:

```sh
vp exec node --experimental-strip-types scripts/build/build-owned-vp8-wasm.ts --generate
vp exec node --experimental-strip-types scripts/build/build-owned-vp8-wasm.ts --check
vp exec node --experimental-strip-types scripts/build/build-owned-vp8-wasm.ts --verify-prebuilt
vp exec node --experimental-strip-types scripts/test/owned-vp8-compiled.ts
```

## Executed local engineering result

The focused `display_rgb::tests` subset passed 13/13. The full locked/offline
crate suite passed 137 tests with 16 explicitly ignored; the separate native
VP8/libvpx decoder run passed all 16 ignored tests. `cargo fmt --check` and
`cargo clippy --locked --offline --all-targets -- -D warnings` passed. The
maintained `--generate`, byte-rebuilding `--check`, and `--verify-prebuilt`
commands passed, as did the compiled ABI2 engineering script's 48 cases,
lease, cancellation, and new-instance recovery checks. The pinned runtime was
Node 26.13.1. These are local engineering checks, not product acceptance.

The candidate's `display_rgb.rs` SHA-256 is
`2b037c60881f1239ba704664173fd789eb8c6837de2cfb045c9d228fd4989c02`;
the crate README SHA-256 is
`d0d5879c9156a0110ee395f276b098cf108ca16ee01e7804e70a004c90c14a41`.
The generated WASM SHA-256 is
`76f7e60d0accc2197f0ef038924eaa89685b28174e018e1e313f5ee06083707c`
(247,029 raw bytes; 81,970 bytes with pinned Node's level-9, zero-mtime gzip).
Its provenance SHA-256 is
`3c331aeb23c2430714fc6308f9ca91c7934cce27e9cf86a489290ddbf99db646`.
An independent audit matched all 28 recorded source digests to live files and
found only the README and `display_rgb.rs` changed relative to the preserved
`b9b7e893` control. Cargo inputs, compiler, scalar target flags, path remapping,
and source list matched the control. The one unshared WASM memory declares
1,114,112 initial bytes and an unchanged 201,326,592-byte maximum. The clean
control's `f962` module, provenance, and README remained byte-identical to
copies retained before generation.

Complete command, stdout, stderr, exit and independent-audit receipts are kept
under the local `wmc-501-vp8-v2/paired-display-chroma-01/{focused-rust-01,wasm-build-01}`
evidence directories. `vp exec` reported the absence of a project-local
Vite+ installation in this manual worktree; its resolved Node executable was
the pinned 26.13.1 runtime, and no install was performed.

The coordinator owns the separate exposed decoder-display and raw-byte equality
campaign, frozen 20-condition equality screen, and only then the balanced
40-condition timing campaign. Preserve failed receipts and bind every result to
its exact source, module, input, and control. A passing local test alone does not
establish decoder parity, a performance benefit, physical memory peak, or product
qualification. The older 627/60 fixed-pixel result belongs only to the
`a83f5b69` / `e918f301` source and module pair; the crate README now identifies
that historical scope explicitly.
