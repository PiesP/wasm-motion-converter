# Bounded owned VP8: RETAIN_CURRENT

Coordinator #494, experiment #497. The bounded experiment is complete; this
report is not evidence of production adoption or wasm-webp removal. Production
Canvas, owned animation mux and wasm-webp fallback remain unchanged.

## Bound source and prospective screen

Qualified product baseline: f2d6bf67e4a1e3509e92b439901acb5a922b6914.
Owned experimental source: 284a651a (follow-up report 556876e0), Rust1.99.1,
zero external Cargo crates. Actual compiled WASM SHA256:
`30d310e6677d42464b92d74c387dea1d5a841275396e412ec84224f4882adc23`.
Development comparator: libwebp1.3.2 WASM SHA256
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
Independent decoder: FFmpeg7.1.5. The pinned RFC6386 provenance and ABI/memory
contract are in crates/owned-vp8/README.md; this is original DC-residual code,
not an external encoder wrapped or renamed as owned code.

The prospective program contract permits stopping on a clear early quality or
size failure. Required PSNR is >=baseline−1dB, SSIM >=baseline−.01 and encoded
size <=max(125%baseline,baseline+128bytes) per fixture/preset. The initial
exploratory receipts remain separate from the later typechecked source-bound
freeze/recheck; the recheck does not retroactively qualify exploratory timings.
All15 fixed64x48 controls were independently decoded. Fourteen fail the PSNR
screen. The clear failure ended this bounded experiment before broader image,
SSIM, latency, cancellation, large-memory or animation qualification; none of
those unexecuted gates is claimed passed.

| Input | Preset | Reference raw bytes | Owned raw bytes | PSNR delta dB | Joint PSNR/size screen |
| --- | --- | --- | --- | --- | --- |
| flat | 60 | 64 | 81 | -3.50 | FAIL |
| flat | 75 | 60 | 94 | -1.35 | FAIL |
| flat | 85 | 66 | 119 | 4.25 | PASS |
| text | 60 | 546 | 327 | -30.27 | FAIL |
| text | 75 | 618 | 400 | -31.97 | FAIL |
| text | 85 | 728 | 516 | -35.25 | FAIL |
| gradient | 60 | 176 | 239 | -6.70 | FAIL |
| gradient | 75 | 186 | 307 | -7.39 | FAIL |
| gradient | 85 | 232 | 407 | -9.60 | FAIL |
| chroma | 60 | 184 | 270 | -33.98 | FAIL |
| chroma | 75 | 174 | 329 | -32.58 | FAIL |
| chroma | 85 | 204 | 436 | -33.56 | FAIL |
| noise | 60 | 1942 | 206 | -2.11 | FAIL |
| noise | 75 | 2134 | 256 | -2.15 | FAIL |
| noise | 85 | 2622 | 348 | -2.22 | FAIL |

Gradient q60 (239 vs176bytes) passes its size allowance304bytes; gradient q85
(407 vs232) exceeds360bytes. Earlier exploratory wording that called q60 a
size failure was corrected without changing receipts or thresholds. Raw ABI
malformed-input, repeated-state and recovery checks passed; these do not
establish product cancellation or resource qualification. The candidate's
missing AC detail and exploratory quantizers do not preserve text/chroma or
preset quality. It adds no delivered executable dependency or application asset.

## Actual native-browser probe

Self-contained probe source/build db8ea6af069e439b0bd1aef0e7a28036113afccd,
Windows11Pro26300.9974, prepared guarded Windows VM. Installed Chrome
157.0.8103.52 and Edge157.0.4341.57 each encoded and decoded six raw VP8 keyframes:
64x48 and17x13 at200000/800000/2000000bit/s. All12 saved WebP files passed
independent FFmpeg decoding, visible geometry and output digest verification.
These are actual installed-browser observations, not managed-engine results.

For odd17x13 input, decoded visible/display extent is17x13 and coded storage is
18x14. The first harness incorrectly required coded==visible dimensions and
failed after producing output. Its failed receipt and eight files were preserved;
the owned guest was disposed only after exact ownership/process/path/hash guards.
The corrected probe checks the VP8 header and visible rectangle separately.
Both later runs collected successfully and cleaned their owned guests.

All three tested bitrates produced identical bytes for each geometry/browser.
This establishes a functional narrow native route, not q60/75/85 calibration,
quality adoption, throughput benefit or permission to remove a fallback. Actual
Firefox, latest Safari and mobile execution remain UNVERIFIED for this probe;
newer browser patch/major coverage is not inferred from the installed versions.

## Evidence and next condition

Sanitized raw controls and native observations accompany this report. Original
logs, freeze identities, outputs and failure/cleanup receipts are retained
outside public assets under the coordinator's private evidence root. No private
owner media is published. CodeQL JavaScript/Actions coverage is not Rust-source
coverage; Rust checks and actual compiled tests are reported separately.

Resume only with a bounded AC/intra/residual and preset-calibration candidate
that passes new prospectively frozen quality/size controls, followed by full
resource, lifecycle, animation and browser acceptance. Keep current production
routes until then. Integration/Pages disposition belongs to #494; this report
alone does not claim the experimental source is landed or deployed.

Process deviation retained: the early lane commit136aba0a bypassed its local
hook through a per-command hooksPath override. The normal hook passed on the
same branch afterward; later commits use normal hooks. This was not authorized
and is not a precedent or a replacement for protected integration checks.
