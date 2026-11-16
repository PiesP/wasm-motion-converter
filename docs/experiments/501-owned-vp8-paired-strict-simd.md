# #501 paired display chroma with strict SIMD compiler permission

Status: exact-output and bounded Node timing diagnostic complete with a
positive Node signal; browser and product qualification remain open. The
measured candidate is signed commit
`bdcc59066bde5ade9d87a7b977cb9559200f9dd4`, based on signed paired-display
commit `e00198fe76afb05e0808cc163227bf219d99e98e` and its
stripped ABI2 WASM module SHA-256
`76f7e60d0accc2197f0ef038924eaa89685b28174e018e1e313f5ee06083707c`
(247,029 raw / 81,970 pinned Node gzip bytes). The newly generated module is
SHA-256 `60ad8ed67a2ea69f19eda2c708ef252e3481b341147793ba6a03a41ae4468554`.
The direct comparison used that immediate paired control, not the older
`f962b9e8` module.

## Single compiler variable

Change only `scripts/build/build-owned-vp8-wasm.ts` from
`-C target-feature=-simd128,-relaxed-simd` to
`-C target-feature=+simd128,-relaxed-simd`. Rust 1.99.1, the release profile,
path remapping, `--export-memory`, the 192 MiB maximum, Cargo inputs and all
Rust encoder source remain as in the paired control. The product keeps its
current ABI2 contract, source/quality decisions, cadence, routes, limits and
dependencies. This flag permits strict WASM SIMD and compiler vectorization;
it does not prove that SIMD instructions are emitted or executed. No explicit
intrinsic, capability probe, scalar fallback or automatic codec retry is added.

The historical strict SIMD compiler control used measured source
`f297e011afd85a877bb763ec1c73dd0826c7ef00` and module
`bfbaff0a0aa94202bf1eeac4104e5e09b2a8e174bbefe25534bbff30affe1f4f`
against the older `b9b7e893` / `f962b9e8` control. Its 20 exact comparisons
passed, and five Node/WASM row medians were 4.15–8.24% lower. Those results
belong to that older source pair. They cannot be transferred or multiplied
with the paired-display result to predict this candidate. No disassembler
proof of emitted SIMD was obtained there, and browser capability was not
qualified. The separate UV-plane rate cache and other deferred mechanisms
are excluded.

## Executed engineering result

The maintained pinned Node 26.13.1 / Rust 1.99.1 locked, offline `--generate`,
byte-rebuilding `--check`, and `--verify-prebuilt` each passed on their first
run. The compiled ABI2 engineering check passed its 48 cases, including
independent decoder fixtures, lease/cancellation and new-instance recovery.
These are Node engineering checks, not browser or product acceptance. First
command, stdout, stderr, exit and status receipts are private under
`wmc-501-vp8-v2/paired-strict-simd-01/wasm-build-01/`.

The generated module is 241,979 raw / 80,167 pinned Node level-9 gzip bytes.
The provenance SHA-256 is
`12a605dff74f30d0deb47291e0487a8be0413cf1ec3d89207c6d256ac16ce35b`.
An independent audit matched all 28 source hashes, the module digest, raw and
gzip sizes, and the one unshared memory declaration (1,114,112 initial and
201,326,592 maximum bytes). The compiled module has zero imports, the 11
required `vp8_v2_*` function exports plus memory, and returns ABI version 2.
The audit passed without asserting that SIMD instructions were emitted.

All 23 Rust source/Cargo/toolchain files are byte-identical to the paired
control. Its 137 ordinary and 16 separately ignored native tests are reused
only for that unchanged source, not reported as new runs for this module.
The candidate has no installed Vite+ test runner and none was installed.
The generic owned-VP8 build-policy test, generator source and host admission
source are byte-identical to the historical strict-SIMD candidate, whose
focused policy test passed 3/3. That historical test is reused only for its
generic policy behavior (historical log SHA-256
`1499b6d7d856e673ae4f013037e8c36359dd106bdcd010b610e27e6d804e6676`);
no candidate-bound focused policy test is claimed. The private
`wasm-build-01/source-identity-audit.json` records the byte comparisons.
The new module's actual admission was checked by the maintained generator,
compiled ABI script and independent audit above.

## Frozen evaluation order (completed through Node diagnostic)

1. Preserve the immediate paired control module outside the candidate
   checkout and verify its digest. Use pinned Rust 1.99.1, locked/offline
   inputs and Node 26.13.1 to run the maintained generator `--generate`,
   `--check` and `--verify-prebuilt`, then the focused owned-VP8 build-policy
   tests and compiled ABI2 engineering check with independent decoder cases.
   Record all 28 provenance input digests, candidate module and provenance
   digests, pinned Node level-9 zero-mtime gzip size, raw size, exact imports,
   ABI2 exports, initial memory and 192 MiB maximum. Retain command, output,
   error and exit receipts, including a first failure. The existing 482,273
   raw / 184,377 gzip byte ceilings remain. The unchanged Rust algorithm can
   reuse its source-bound native evidence; this does not substitute for the
   newly compiled module's checks. A disassembler may separately establish
   emitted SIMD opcodes, but the compiler flag and a successful build cannot.
2. After a clean signed source/module/provenance freeze, compare the new
   module directly with `e00198fe` / `76f7e60d` on exactly 20 frozen
   input/quality conditions. Require identical raw VP8 bytes, ABI step counts,
   status sequences and stage traces. The five retained actual browser RGB
   q60 rows must also match their original ANMF raw VP8 bytes. Previously
   verified independent decoding may be reused only by complete raw-byte
   identity and labeled as reused, never as a new decoder run. The historical
   `f962` module and `b9b` capture retain their distinct source and input
   roles; they are not the direct performance control. Any mismatch or failed
   gate stops the timing admission and remains recorded.
3. Only after all 20 rows pass and the candidate is a genuinely changed
   compiled module, perform one serialized Node/WASM cohort on those five
   actual RGB q60 frames: one warm encode per module and row (10 total), then
   one ABBA and one BAAB block per row (40 timed encodes total). Bind each
   sample to exact module, input/output, steps, status and order; report all
   medians, ranges, MADs and candidate/control ratios. Keep unfavorable and
   timed-out samples. Do not rerun an unchanged candidate to seek a better
   result. Node elapsed time is an engineering signal, not installed-browser
   or whole-product throughput.

## Frozen equality and Node timing result

The one 20-condition screen compared the measured module with the immediate
`e00198fe` / `76f7e60d` control. All 20 rows matched raw VP8 bytes, ABI step
counts, status sequences and stage traces. The five retained actual RGB q60
rows also matched their original ANMF raw VP8 payloads. The prior independent
decoder evidence for those five rows is reused by complete raw-byte identity;
this screen did not run fresh decodes for them. Its equality summary SHA-256 is
`4e7c939b2ac07b6bf4375620d446ed94d0d8bc59824e9e5f12bd2594cb2098e4`.

Only after equality passed, one serialized Node 26.13.1 cohort completed
exactly 10 warm and 40 timed encodes: four timed encodes per module and actual
RGB row, one ABBA and one BAAB block. Candidate/control median elapsed-time
ratios, using unrounded medians, were:

| Actual RGB row, q60 | Control median ms | Candidate median ms | Candidate/control |
| --- | ---: | ---: | ---: |
| 00 | 662.730 | 626.231 | 0.9449255910455041 |
| 19 | 623.653 | 585.586 | 0.9389618986635014 |
| 38 | 645.090 | 591.197 | 0.916457087862621 |
| 57 | 664.150 | 627.035 | 0.9441170762851582 |
| 76 | 493.538 | 461.188 | 0.9344535742302715 |

Every row's candidate median was 5.5074–8.3543% lower than its immediate
control median. The timing summary SHA-256 is
`776bcefa6cf08b71d53676459b17001468126a0abeb765390a1188616a3ed49f`;
the 40-sample raw receipt SHA-256 is
`a81cad4e844ad7b9edf0a8de27ef6da6af49e9f819cfc2017c58af59ef611f7a`.
The private `root-timing-audit.json` independently checked sample schedule,
input/output identities, terminal states, capacity and statistics and passed.
All warm and timed samples reported 20,512,768 bytes of retained WASM linear
capacity. That is an ABI capacity observation, not physical peak memory or
cumulative allocation. Exact samples, ranges and MADs remain in the receipts
under `wmc-501-vp8-v2/paired-strict-simd-01/`.

This is a promising Node/WASM encode signal for this source/module pair.
Do not multiply it with the historical `f297` result or rerun an unchanged
candidate to seek a better result. The exact module still needs browser SIMD
capability and product qualification; the flag and elapsed times do not prove
which SIMD opcodes were emitted or executed.

## Qualification boundary

The current runtime loads one owned module; an unsupported browser compile
remains an observable load failure rather than selecting another backend.
Before adoption, the exact new module needs installed-browser load and
execution evidence in the main and Worker software routes, with the required
service-worker/offline/update and MIME/CSP checks. Recheck active owned work
Stop-to-idle at most 500 ms, no stale/cancelled publication, same-document
recovery, bounded memory and host copies, complete animation decode, exposed
and fresh quality/size conditions, whole-product performance, delivery size
and protected integration. The shipped patched `wasm-webp` primary remains
unchanged until #501 qualification permits runtime removal. Node equality,
ABI and timing results cannot establish physical peak memory, browser SIMD
support, opcode execution or product acceptance.
