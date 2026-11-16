# #501 quality-60 deblocking control

## Premise and fixed source

The signed `844cfcb9f084ff663ac8198f68372387394f1b71` RGB-SSD guard passed
all 45 tuning and five actual-browser-RGB PSNR, SSIM and size gates against
the shipped patched wasm-webp comparator. Its frame 76 original-source PSNR
still failed by 1.704513 dB, and its raw VP8 and decoded RGB were unchanged
from BD170. This diagnostic branch starts from the same module at source
`a9202d99834a77a54728787804fd1213e7b74588` after the guard result was
recorded. The separate UV DC -9 and mixed DC-zero candidates remain failed
historical points. The mixed DC-zero point passed 49/50 exposed rows but
frame 76 exceeded its 10,815-byte limit at 11,060 bytes; its original-source
PSNR delta was -1.702031 dB. No result isolates deblocking as the cause.

The original-reference and browser encoder-input RGB differ before this VP8
encoder runs. At frame 76, their pinned source-to-Canvas PSNR is 40.570214 dB
in the source-bound `11f36894` diagnostic. That input gap is a distinct
constraint, not an estimate of the filter's effect or a waiver of the final
quality gate.

## One controlled change

Set the default VP8 deblocking filter level for quality 60 from 6 to 0.
Keep quality 75 and 85 at level 4. This applies to every quality-60 profile;
there is no content-dependent filter selection. Retain the guard's original
mixed-profile UV DC delta -8 and all other profile eligibility, quantizers,
mode/refinement algorithms, color conversion, geometry, frame cadence, ABI,
resource ceilings and the pinned primary comparator. Explicit custom filter
configurations used by the filter/header/independent-decoder tests still cover
enabled filtering at level 6 and other levels. The default-level test now
expects zero for quality 60.

This is a diagnostic control. Disabling the output filter can change decoded
RGB, frame bytes and temporal appearance, while intra prediction still reads
unfiltered reconstruction. A result cannot be inferred from the old source or
from the input gap above.

## Prospective gate

Run focused filter/header tests, native tests and both independent VP8 decoders,
then regenerate and verify the owned WASM and compiled ABI2 artifact before
measuring. Keep the same 15 tuning IDs at q60/75/85, five actual-browser-RGB
frames at q60 and five separate original-source comparisons. Each applicable
row requires PSNR at least the shipped primary minus 1 dB, SSIM at least
primary minus 0.01, and raw VP8 bytes at most
`max(1.25 * primary, primary + 128)`. Every original-reference PSNR and SSIM
floor remains separate. Preserve failed receipts and the unchanged thresholds.
A passing diagnostic subset only permits the full 77-frame, 687-condition and
fresh held-out checks plus actual software-route browser, performance,
resource, cancellation and delivery qualification.

## Engineering checkpoint

Pinned Rust 1.99.1 fmt/check, the focused filter/header test,163 ordinary tests,
all17 explicit independent-decoder/property tests, and all-targets Clippy
with warnings denied pass. Maintained WASM generation, an independent
byte-identical rebuild and prebuilt verification pass.

The first compiled ABI command failed its V9 q60 raw-hash known answer after
the intended filter-header change. Its40869-byte payload now hashes to
`cab0d65b24b4bd689511b24630000fe7c743c136adc0bea1e7fd28bcded2aa16`
instead of the prior8660307d prefix. The first failure, exact script and streams
remain in private `compiled-v9-expectation-audit-01`. Two explicit native VP8
and libvpx decodes both reproduce the unchanged expected169451-byte YUV
`399d837e7b36403510975d12a529d1dbf9cb5271b95e3ac84168d692dee4125c`.
Only the raw-hash expectation changed; byte count and YUV expectation remain.
The separate corrected compiled command then passed all48 ABI2 cases. The
first command retains its failure status.

Module `1fb35e5ce5179f6f4279aba9ae7cae32200363051725e838c3065a6f63d2f131`
is246671 raw/81975 Node gzip level-9 bytes, zero new imports/dependencies,
with unchanged initial1114112/max201326592 linear bytes. Root rehashed all28
provenance inputs and module; provenance SHA-256:
`52da97af5b7f6147e7fce432064bdaff353f9cf3f028e336edaa09d6da92eceb`.

Quality, size, product performance/resource, browser acceptance and delivery
remain NOT_RUN for this point. Freeze the clean signed source/module before
the diagnostic screen. Production wasm-webp remains.
