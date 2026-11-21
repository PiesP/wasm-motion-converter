# #501 exact I4 mode pruning experiment

## Prospective contract

The original candidate is `ef7e578d` with compiled module SHA-256
`a69c333b80eca3e8f9a400e8969209ba7d6ebeb66c633fb4669d1c1b776cdc6d`.
Retain that module as the output and timing control. A single first decoded V8
1920x1080 RGBA frame, SHA-256
`2be650f07cbe6f16390fdeb386a0ed8524f45533fe17209959b5d523d646b5ae`,
showed Stage 2 analysis at 72–74% of instrumented WASM step time. This is a
diagnostic on one frame, not a product throughput distribution. The source-bound
plan and log are retained outside Git under
`.codex-artifacts/wmc-501-vp8-v2/v8-first-frame-stage-{plan.json,profile.jsonl}`.

The change may only skip I4 mode work when a candidate cannot beat the current
winner under the existing integer score. It must preserve ten-mode enumeration,
strict-less-than ties, quantizers, presets, rate model, output bytes, ABI step
cadence, resource ceilings, and all existing acceptance gates.

For each four-by-four block, first count the mode syntax cost. Before prediction,
`lambda * mode_cost` is a lower bound because distortion and coefficient token
costs are nonnegative. After reconstruction, `distortion * 256 + lambda *
mode_cost` is a tighter lower bound. A mode with either bound greater than or
equal to the current best score cannot replace it because ties keep the earlier
mode. Only the winning mode updates tile and coefficient contexts. An exhaustive
test-only search remains an oracle. Compare its selected modes, coefficients,
reconstruction, distortion and accumulated score across edges, contexts,
quantizers, lambdas and deterministic input patterns.

Gate in order: focused Rust oracle, locked offline Rust tests, formatting and
Clippy; generate and independently check the release WASM and provenance; run
the compiled ABI2 test. Compare old/new encoded bytes on the same V8 first
frame at q60/q75/q85 and on small fixed fixtures. If bytes differ, stop the
exact-output claim and investigate. A finite serial diagnostic may compare
control and candidate runtime on this one input. Report every sample without
turning a single instrumented observation or an untimed unit test into a speed
claim. Product acceptance still requires the separate V8 Windows campaign and
the frozen size, quality, resource and lifecycle gates.

## Outcome

The generated release WASM SHA-256 is
`f962b9e803a014febc96d9a59bbab8faeb032866e837136c6afd8dd972fc4186`.
It is 243,208 raw and 81,148 gzip bytes, with a declared 192 MiB memory
maximum. The pinned generator and independent `--check` agree on artifact and
source provenance. The original `a69c333b` module was copied unchanged to
the retained `exact-rdo-pruning-01/original-opt3-a69.wasm` artifact before
regeneration. All 136 regular Rust tests, 16 ignored independent-decoder tests,
formatting, Clippy and compiled ABI2 engineering checks passed.

The source-bound `exact-rdo-pruning-01/comparison.json` compares one serial
original/pruned encode for each of q60/q75/q85 on the first V8 frame and six
fixed generated inputs (flat, text, gradient, noise, tiny and one-column).
All 21 input/quality rows were byte-identical, with unchanged ABI step counts
on the V8 frame. The original/pruned frame SHA-256 values for that frame are
`02f5e80e` (q60), `ecd756f2` (q75) and `2bb1c392` (q85), shown here by prefix;
the receipt retains the complete digests.

A separate warmed, serial, uninstrumented Node/WASM ABBA diagnostic used the
same V8 pixel buffer, module digests and q60/q75/q85 requests. Every output
matched byte-for-byte. Its two elapsed samples per module and quality are in
`exact-rdo-pruning-01/paired-v8.jsonl`. Median original/pruned elapsed times
were 801/704 ms at q60, 831/711 ms at q75 and 872/771 ms at q85. The
observed median reductions were 12.1%, 14.4% and 11.7% on this single frame.
The tiny sample and Node host do not establish browser or whole-product speed.
The Windows V8, quality, resource and lifecycle gates remain open for this new
module. Prior failures and the original candidate receipts remain historical
evidence; they are not reclassified by this diagnostic.
