# #501 owned VP8 release-profile throughput control

This is a prospective, one-variable compiler-profile experiment for the candidate
product-owned ABI2 encoder. The previous frozen module, SHA-256
`e918f3016451b60f04dfa551e5ae57820bcbc65c8c8834f01c8426b72355e584`,
was built with Cargo `opt-level = "s"` at source `261cb630616062e020a1b5c43f64ddadb9a1f0b9`. It is 236,365 raw and
60,652 gzip bytes. Preserve its binary and failed product receipts as the
control. The candidate changes only Cargo release `opt-level` to `3` and the
closed-input manifest digest in the build script; this README records the
experiment and is included in source provenance. Rust algorithms, quality
presets, bitstream policy, cadence, ABI, resource ceilings and acceptance gates
are unchanged. A compiler optimization may still alter output or resource use,
so each property needs measured evidence.

The frozen owned-module ceiling remains 482,273 raw / 184,377 gzip bytes
(`gzip` level 9, mtime zero), with a 192 MiB declared linear-memory maximum.
The existing product distribution and whole-product budgets still apply. A
module under its byte ceiling alone does not pass the distribution budgets.

## Evaluation order

1. Keep the original binary identifiable by the digest above before generating
   the candidate. Generate from the pinned Rust toolchain with `vp run
   build:vp8-wasm:generate`; run `vp run build:vp8-wasm:check` to compare the
   complete recorded artifact with an independent locked offline rebuild. Record
   the candidate source, binary SHA-256, raw/gzip sizes, source manifest and
   build environment. Stop if any immutable budget, export, memory or provenance
   check fails.
2. On identical fixed pixel buffers, geometry, layout and q60/q75/q85 requests,
   compare each candidate VP8 frame byte-for-byte with the retained
   `opt-level = "s"` module. Include a flat, color-edge, photographic and noisy
   input plus odd geometry and duplicate-hold cases. Record both module hashes,
   input pixel hashes and any differing output hashes. A difference requires
   independent decoding and the frozen per-fixture quality/size checks; do not
   infer output equality from unchanged Rust source.
3. Run the existing compiled ABI2 Node validation and frozen exposed regression
   cohorts against the candidate. Keep the first-V12 60-condition result and
   earlier exposed results as historical evidence, then re-evaluate applicable
   fixed-pixel conditions and independent quality/size oracles for the new
   binary. Check the unchanged resource, cancellation and bounded-step
   contracts. A clean module check is not codec or browser qualification.
4. With host load serialized, time the two binaries on the same fixed pixel
   inputs, settings and Node/WASM runner. Warm each module, alternate control
   and candidate order, retain every elapsed sample, and report per-input and
   per-quality median, range and median absolute deviation. Bound the local
   trial count and stop on a timeout instead of dropping that sample. This
   diagnostic isolates encoder throughput; it does not substitute for installed
   browser whole-product timing.
5. If the local control is favorable and all earlier checks pass, repeat the
   full source-bound Windows product V8 low/medium/high paired AB/BA campaign
   and the separate functional, output, resource and lifecycle gates. Use the
   frozen thresholds and the existing receipt verifier in
   [the timing contract](501-owned-vp8-product-timing.md). Do not reuse old
   candidate receipts for the new module.

Prior V8 observations motivating this control were approximately 85–90 seconds
owned versus 17 seconds prior at low, 132–136 versus 27 at medium, and an owned
high run that timed out after about 180 seconds at 146 of 180 frames. These
observations are failed, incomplete product evidence, not a paired result for
this compiler profile. No speedup or adoption claim follows until the above
measurements and independent gates pass.

## Local outcome on the candidate branch

The original `e918f301` binary was copied from source revision
`261cb630616062e020a1b5c43f64ddadb9a1f0b9` before regeneration and its
digest was checked. The candidate module SHA-256 is
`a69c333b80eca3e8f9a400e8969209ba7d6ebeb66c633fb4669d1c1b776cdc6d`:
243,199 raw / 81,056 gzip bytes, with the required 192 MiB maximum. The
pinned Rust 1.99.1 locked/offline generator and independent `--check` agreed
byte-for-byte. The `vp run` wrapper could not load this manual worktree's task
graph because project-local dependencies were absent; the documented direct
Node build entrypoint ran successfully, and the check was repeated with the
`.node-version` 26.13.1 executable.

The finite Node/WASM control used the existing ABI2 test driver and frozen
generated/tuning fixtures, plus one deterministic 320×180 synthetic texture.
Each module was warmed once per input/quality, then timed in ABBA order with
two samples per module. All 18 input/quality rows at q60/q75/q85 produced
byte-identical VP8 frame output across modules and repeated samples. The
selectors covered flat, chroma edge, tuning photograph, noise, odd geometry,
and the 320×180 synthetic texture. Repeated encoding of the same buffer covered
determinism; the separate external-video duplicate-hold fixture was **NOT_RUN**.
The local timing includes the Node test driver's ABI and copy work, so it is a
diagnostic, not codec-only or whole-product timing. Full samples and pixel/frame
hashes are retained in the local control receipt.

| Fixed pixel input | Quality | `opt-level = "s"` median ms | `opt-level = 3` median ms |
| --- | ---: | ---: | ---: |
| flat 64×48 | 60 / 75 / 85 | 2.320 / 2.385 / 1.413 | 1.701 / 1.690 / 2.108 |
| chroma edge 64×48 | 60 / 75 / 85 | 13.384 / 15.703 / 17.111 | 9.875 / 13.019 / 13.294 |
| tuning photo 128×96 | 60 / 75 / 85 | 12.578 / 12.968 / 14.147 | 10.717 / 11.721 / 11.321 |
| noise 64×48 | 60 / 75 / 85 | 9.083 / 7.246 / 7.521 | 6.536 / 6.233 / 6.435 |
| odd gray sweep 257×33 | 60 / 75 / 85 | 10.276 / 10.187 / 10.168 | 6.894 / 6.622 / 7.215 |
| synthetic texture 320×180 | 60 / 75 / 85 | 48.556 / 49.965 / 61.340 | 37.295 / 38.481 / 47.398 |

The small flat q85 case was slower in this two-sample control. The independent
compiled ABI2 Node suite passed 48 engineering cases, including `vp8` and
`libvpx` decoding, lease, cancellation and bounded-step checks. These checks
are not the 627 exposed quality conditions or first-V12 60-condition cohort.
The external-video duplicate hold, those complete independent quality/size
campaigns, product distribution budgets, installed-browser timing, functional,
resource and lifecycle gates remain **NOT_RUN for this binary**. The candidate
is an unqualified experiment until those gates finish.
