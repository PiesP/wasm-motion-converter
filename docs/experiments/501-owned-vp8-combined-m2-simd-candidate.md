# Combined M2 and strict compiler candidate

This is a new source combination, not a qualified runtime replacement. Start
from Y1 M2 metadata head `1a11279d9a1cf2f6b7563bf88e212a720a0d5e9d`
(measured `1e80f53b`, module `fc13fa5f`), add only the paired-display
`display_rgb.rs` from `e00198fe`, and use the strict compiler generator from
`bdcc5906`. The original component sources, failed experiments and receipts
remain unchanged. No new production dependency, preset, layout, ABI, work
quantum, resource ceiling, geometry, frame selection or cadence change is made.

The Y1 component passes its single 50-condition screen, saved-45 paired decoder
proof and 687 exposed conditions. The latter comprise 45 current rows reused
and 642 new, with independent bytes/PSNR audit. The paired-display component
and strict compiler combination each has its own positive Node signal. Those
different-source ratios cannot be transferred or multiplied. Compiler SIMD
permission does not by itself prove emitted or executed SIMD instructions or
installed-browser support. No automatic scalar retry is added.

## Prospective engineering and comparison

1. Check the actual combined native Rust suite, explicit independent decoder
   cases, fmt and Clippy. Generate with the pinned Rust 1.99.1 and Node 26.13.1
   locked/offline conventions; require maintained check/prebuilt, compiled
   ABI2, all 28 provenance inputs, imports/exports and initial/maximum memory.
   Keep the existing 482,273 raw / 184,377 Node-gzip byte ceilings and 192 MiB
   maximum. Record a clean signed source, module and tooling freeze before
   comparative encoding. Build failure or a stale identity stops this stage.
2. Compare exactly 20 fixed input/quality conditions with immediate scalar Y1
   control `1a11279d` / `fc13fa5f`: the same five fixed inputs at q60/75/85 and
   actual post-Canvas RGB indices 0/19/38/57/76 at q60. Require identical raw
   VP8, ABI steps, statuses and traces. For the five actual inputs, also bind
   the saved Y1 candidate raw VP8 payloads; they are fixed-pixel reencodes, not
   new browser ANMF evidence. Old f962 ANMF payloads have a historical input
   provenance role and are not the expected output of the changed Y1 codec.
3. Only after all 20 identities pass, run one 10-warm/40-measured balanced
   ABBA/BAAB Node comparison. Preserve every sample, median, range, MAD,
   retained capacity and source/input/settings/cache identity. Time only the
   encode call without step tracing; do not rerun an unchanged slow cohort.
   These measurements do not establish whole-product acceptance.
4. Require complete same-687 source/input-bound output identity or a separately
   prospectively frozen full quality evaluation before reusing the Y1 quality
   and decoder evidence. Do not infer 687-condition identity from only 20.
   Identify every newly executed and reused artifact. Historical V1–V12 stay
   exposed regression; any truly new held-out successor remains separate.

The primary product comparator remains the shipped patched wasm-webp 0.1.0,
not another owned module or a newer libwebp. Preserve the PSNR >= primary minus
1 dB, RGB SSIM >= primary minus .01, and size <= max(1.25 times primary,
primary plus 128 bytes) rules. Product medians, full-animation geometry/timing/
order/loops/color, deduplicated holds, admitted large inputs, active Stop,
same-document recovery, actual browser capability/resource evidence and final
CI/security/delivery/provider gates remain mandatory. No runtime wasm-webp
removal, physical zero-copy/peak claim, merge or deployment is established here.

## Current state

Source integration, native Rust and compiled ABI2 engineering are complete.
The first pinned
format check, locked/offline ordinary suite (161 passed, 17 ignored), separate
independent-decoder ignored suite (17 passed), and Clippy with warnings denied
all passed. Their command, stdout, stderr, exit, status, and source-bound
receipts are retained privately under `combined-m2-simd-01/native-01/`.

Pinned Rust 1.99.1/Node 26.13.1 maintained `--generate`, byte-rebuilding
`--check`, `--verify-prebuilt` and compiled ABI2 engineering (48 cases,
including independent decoder fixtures) each passed on its first run. The
generated combined module SHA-256 is
`bd170496ba1f2574bd095effdc55b7cd102b203dcc347a472141fcfbd9284b0e`:
245,106 raw / 81,480 pinned Node level-9 gzip bytes. Its provenance SHA-256
is `5314b3953c97a28179f5a7f013a042c1181003e2b8b6330c846a676e74540b7b`.
An independent audit passed all 28 source digests, module/raw/gzip identity,
zero imports, memory plus 11 ABI2 function exports, version 2 and one
unshared memory with 1,114,112 initial / 201,326,592 maximum bytes. First
command, stdout, stderr, exit and status receipts are private under
`combined-m2-simd-01/wasm-build-01/`; the original scalar Y1 module and
provenance were preserved at `combined-m2-simd-01/` before generation.

The candidate worktree has no installed Vite+ test runner, and none was
installed. The generic build-policy test, generator and host admission source
are byte-identical to the historical strict-SIMD candidate, whose focused
policy test passed 3/3. That is reused generic policy evidence, not a new
candidate-bound policy test. `wasm-build-01/policy-source-identity.json`
records the comparison; the new module's actual admission is covered by the
maintained generator, compiled ABI script and independent audit above.

Exact-output, Node performance, full 687-condition identity, fresh,
browser/product and delivery checks have not run for this combination.
Component result documents retain their own actual source and environment
identities. Neither the compiler flag nor these engineering checks establish
emitted or executed SIMD instructions, browser compatibility or product
adoption.
