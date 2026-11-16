# #501 mixed-profile Y1 AC rate-allocation candidate

## Measured premise

The preceding signed UV DC -9 candidate
`3c6a163c71e9dabe71c962877846fa520eb766d6` passed 45 tuning rows but
only 48 of 50 exposed quality/size conditions. Frame 38 raw VP8 was 33,469
bytes against a 33,402.5-byte limit; frame 76 was 12,014 against 10,815
bytes. Separate original-source frame 76 PSNR was 41.511394 dB versus the
shipped primary's 42.701327 dB, a -1.189932 dB delta below the unchanged
-1 dB floor. This improved by about 0.51458 dB over the earlier guard point
but did not qualify adoption. The frozen results and failures remain in
`501-owned-vp8-mixed-uv-dc-precision.md` and its private receipts. This new
branch starts from result-bearing source
`b7d9836cdd3fe847412acb534f1645a929ef9801` with the same measured
encoder configuration. The later DC-zero and q60 filter controls are separate
failed experiments and are not incorporated here.

## Single bounded rate-allocation change

For the existing eligible mixed quality-60 profile, widen only the marginal
Y1 AC unit-coefficient zero bin from the strict `8 * abs(transformed) <
5 * Y1_AC_step` decision to strict `8 * abs(transformed) < 6 *
Y1_AC_step`. The test applies to coefficient positions 1 through 15 only
when nearest quantization produced `+1` or `-1`. It preserves DC, larger AC
levels, signs, all noneligible frames, and the existing wide unsigned
magnitude handling. No dequantization step/table, UV DC -9 or UV AC setting, mixed-profile
classifier, filter level 6, RGB SSD guard, mode/refinement search quota, ABI,
resource limit, geometry or frame cadence changes.

For the eligible Y1 AC steps 14, 26 and 40, the first retained unit
magnitudes become 11, 20 and 30. Magnitudes 9-10, 17-19 and 25-29 are
newly zeroed respectively; the exact equality at magnitude 30 and step 40
retains the coefficient. The prior 5/8 decision and its measured history
remain in `501-owned-vp8-y1-ac-zero-bin-candidate.md`.

The hypothesis is that fewer marginal Y1 residual symbols may recover some
raw-byte headroom while retaining the finer UV DC reconstruction of the -9
point. Coefficient removal can alter later prediction and decoded quality;
there is no expected PSNR, size or performance pass. This rule changes both
I4 and I16 analysis through their shared quantizer before committed contexts,
reconstruction, skip decisions and entropy statistics are frozen.

## Prospective validation and decision

Check below, newly zeroed, exact threshold and above-threshold magnitudes for
both signs at all three steps, disabled canonical quantization, skip/context
state, I4/I16 reconstruction, sync/resumable output agreement and independent
native VP8/libvpx decoding. Run the maintained Rust/WASM, provenance and
compiled ABI2 gates before measurement. The 15 tuning IDs at q60/75/85,
five actual-browser-RGB q60 frames and five separate original-source
references retain PSNR >= shipped primary - 1 dB, SSIM >= primary - 0.01,
and raw VP8 size <= `max(1.25 * primary, primary + 128)`. Each exposed row
must pass independently; the original-source PSNR/SSIM checks remain separate. Preserve
first failures and do not change thresholds after seeing this source's result.
Full 77-frame, 687-condition, fresh held-out, actual software-route product
performance, resource, cancellation and delivery gates remain separate.

## Engineering checkpoint

Pinned Rust1.99.1 fmt/check, five focused zero-bin tests,163 ordinary native
tests,17 explicit independent-decoder/property tests and all-targets Clippy
with warnings denied pass. Maintained WASM generation, independent
byte-identical rebuild, prebuilt verification and48 compiled ABI2 cases pass.
Local static review found no production Rust defect.

Review found the README still called the current threshold5/8. Its old
paragraph is now explicitly historical and a short current6/8 link points
here. The initial README/module/provenance remain retained in private
`readme-threshold-fix-01`. Generation, rebuild and prebuilt checks were run
again after that documentation correction. The generated module is byte
identical and README is the only changed closed provenance input; reuse
the existing48-case receipt at its actual module hash, without claiming
another compiled/native run.

Module `e1deb121597315ef2b31bfc9b9c9e7302ba171a03e9809d11fcd455da33a72dd`
is246671 raw/81976 Node gzip level-9 bytes, with unchanged initial
1114112/max201326592 linear bytes and no new imports/dependencies. All28
source inputs and the artifact were independently rehashed. Provenance:
`587c5d55d24f71e2fe49349d60b89121ad23fa678b5419c0d6ed54074119aef2`.

Codec quality/size, product performance/resource, browser acceptance and
delivery remain NOT_RUN. Freeze a clean signed source/module before the
diagnostic screen. Production wasm-webp remains.
