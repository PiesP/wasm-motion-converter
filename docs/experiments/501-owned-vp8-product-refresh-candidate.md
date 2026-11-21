# Product engineering refresh candidate, quality hold retained

Historical product snapshot at `16d8c0cc`. The later filtered-refinement import
is recorded in [the byte-window candidate](501-owned-vp8-product-byte-window-candidate.md);
its checks do not retroactively qualify this snapshot.

This refresh prepares M3/product-path diagnostics, **not adoption**. Main and
conversion Worker use the narrow existing owned adapter and animation mux in
this unmerged candidate branch. Master still uses wasm-webp.

Hardened harness source follows `f37daeb0`: actual near-cap generated VP9 input,
independent prior/candidate attempts, complete controlled-scene/hold checks and
no-clobber fixture generation. Its original and corrected lane commits remain
preserved. The controller accepts the exact `dist-validation` generated path;
the public `build:ci` package entry delegates once to the canonical native task.
The V8 timing workload, existing duration tolerance and production behavior on
master remain unchanged.

The refreshed Rust source matches qualification source `da3b60ed`, with WASM
SHA256 `4447c92b5ec8b896ec22b2cd52219458a49e97e220ebe6406d6f9e25002fd132`.
Product provenance is rebuilt with this branch's own README and builder hashes;
experimental branch runtime files are not transplanted. This engine passed 333
exposed conditions but its first v7 evaluation failed three new tiny SSIM
conditions, 51/54. Those failures and later correction candidates remain tracked
in [issue #501](https://github.com/PiesP/wasm-motion-converter/issues/501).
Source/package/build success cannot clear that quality hold.

Reason for independent M3 preparation: the engine adds bounded preview/reset/
model stages that need actual host integration checks, while near-cap native
decode and controller/scene-oracle behavior are independent capability gaps.
These diagnostics may proceed while M2 correction continues. They do not turn
an unqualified encoder into a software replacement; final source-bound product
and performance checks must execute the eventually admitted engine again.

Before execution, register the actual clean source, product WASM/provenance,
fixtures/settings, selected prepared Windows VM/controller lease and coverage.
Use maintained guarded scenarios; preserve prior failures and unrelated
processes/settings. Candidate must show actual owned begin/steps and saved
independently decoded output. Capability query alone is not a successful
conversion. Active cancellation, no publication and explicit same-document
new-request recovery remain binding. Whole-product balanced timing, source-PTS
temporal fidelity and final executable-asset removal are separate pending gates.

The dependency and old executable assets remain until all adoption/removal gates
pass. Do not merge this candidate as runtime adoption or close #501 from it.
