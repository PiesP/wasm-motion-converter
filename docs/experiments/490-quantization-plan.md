# GIF quantization experiment 490: prospective plan

This experiment compares the locked gifenc 1.0.3 RGB565 PNN route with one
conversion-owned TypeScript histogram/bin-reuse candidate. It preserves the
ordered palette and existing `applyPalette`, dithering, decoder, Worker,
settings, GIF writer, and static Pages product. The lockfile records gifenc
`sha512-xdr6AdrfGBcfzncONUOlXMBuc5wJDtOueE3c5rdG0oNgtINLD+f2iFZltrBRZYzACRbKr+mSVU/x98zv2u3jmw==`.
The installed package's ESM file and PNN source must be hashed in the private
freeze alongside the final source, core gitlink, build, harness and input.

## Workloads and independent output oracle

The primary input is the owner-provided 1,092,710-byte MP4 with SHA-256
`c1ebdf56c8af5d830c6b86689d2bff05cbc3f371da3b1c898c4cfad8a335373c`.
Only a byte-identical, task-owned copy under `validation/windows/private-inputs/`
may enter the focused VM bundle. The original is preserved. The 720 × 720,
variable-PTS video is converted for its full duration at GIF medium, scale 1,
skip off. Secondary uses the same settings with low skip. The small control is
the maintained 5,184-byte synthetic MP4 with SHA-256
`de4c15ff513d41c964eadb5d45ce08030b2a94eea501e9f86edfd8a301e1411e`,
GIF low, scale 1, low skip. Default GIF medium, scale 0.75, skip off receives
one separate correctness/loading qualification per variant and no median claim.

Before candidate timing, baseline saved files are independently decoded with
the installed browser's `ImageDecoder`. Freeze every composited RGBA frame hash,
frame order and duration, total duration, loop count, saved-byte SHA-256 and
size for each workload. Candidate files must match those exact ordered records;
for this fixed encoder route require saved-byte equality. The independent
verifier remains outside measured latency. The current output counts from issue
483 are historical observations, not this experiment's oracle.

## Sampling and decision

Run five balanced, interleaved invocations for each variant and workload. A
focused controller invocation launches one fresh browser process/profile,
converts once on first use and once in the same document with a new Worker.
Thus primary, secondary and small control each have five first-use and five
warm samples per variant. Keep per-invocation build, input, Worker, saved-output,
browser and cleanup identities. The request-click to matching download-ready
latency includes any fetch, initialization, copies and output conversion. Retain
raw samples, median, range and MAD. Quantizer-stage diagnostic builds are
separately identified and excluded from the product timing set. Do not overlap
VM timing with another shared campaign or task-owned heavy work.

The helper calls the second conversion `warm` because it is in the same
document; that label alone does not prove a browser cache hit. Classify each
Worker URL using its Resource Timing transfer/delivery fields, the static
server's request list before and after the pair, and service-worker controller
state. A pre-candidate amendment (private record SHA-256
`a2ebe8fe0d5ba5274f4f4a7b231f60c15aa146917e2f64c4ea5bbd0179c45eaa`)
also admits a distinct service-worker CacheStorage class: the exact Worker
resource must report `deliveryType: cache-storage`, retain the same controlling
service worker, and add no host request for its source-bound Worker asset. With
no controller, an explicit browser cache delivery type or zero transfer with a
positive encoded body and no new host request supports the separate browser
HTTP-cache class. New host requests, overflow, or ambiguous or missing signals
remain unqualified. The amendment was frozen after baseline row 1 and before
any candidate timing; it changed no numeric gate or execution limit. The
original plan's browser-cache-only wording is preserved in its recorded digest
`e79fe1d071312c316289d279b6ddeb8e8f77ab3ff0099c076768b102a9c5bdf7`.

Adopt TypeScript only if the primary warm median saves more than 5 ms and more
than `3 × max(baseline MAD, candidate MAD)`, with the added maintenance,
bytes and memory justified. A scalar Rust/WASM candidate is admitted only if
the best correct TypeScript route leaves enough measured quantizer cost to
plausibly save at least 10% and 100 ms in the product. Adopt WASM only if it
actually clears both and the same noise screen. First-use primary, secondary
and small-control regressions must not exceed the larger of 10% of each
baseline median and 30 ms. Active-stage Stop-to-idle must be at most 500 ms,
with no stale success and successful same-document recovery. Preserve original
failed attempts and one evidence-justified refinement and confirmation limits.

## Prospective limits

- Conversion timeout: 180 seconds; saved output: 96 MiB; independent decoded
  output: at most 400 frames.
- Candidate-specific initial JavaScript gzip increase: at most 1 KiB; deferred
  JavaScript gzip increase: at most 12 KiB. Measure both from corresponding
  same-build hashed assets and record compiler settings.
- Reserve 16 MiB in the aggregate Worker guard for the candidate's at most
  65,536 retained bin objects, histogram slots, ordered references and heap.
  This is a conservative source-level allocation charge, not a measured JS
  heap or native peak. Record live scratch and output allocations concurrently;
  adoption requires the selected VM/browser admission and memory observations.
- Any Rust candidate must prospectively declare its own initial/deferred byte
  and linear-memory/copy/overlap budgets before results. No WASM resources are
  introduced merely to establish the TypeScript comparison.

The final private freeze must bind numeric budgets and exact source/build/input/
environment/oracle identities before candidate timing. If the TS candidate
loses, restore current product code and retain only useful regression support
and source-bound evidence. A no-WASM outcome leaves no Rust build material in
the product tree.
