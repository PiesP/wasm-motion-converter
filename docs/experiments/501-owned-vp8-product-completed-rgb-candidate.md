# Product completed-RGB profile engineering checkpoint

This page records the experimental product import of engine
`04b1248022fcd2558653a88ab92b90164db4658d` after the historical
[byte-window product point](501-owned-vp8-product-byte-window-candidate.md).
Production master retains wasm-webp; this is not runtime adoption or removal.

The existing q60 high-chroma Original/Reduced profiles now compare completed
visible owned-renderer RGB SSE times256 plus the same weighted block/header
rate. The changed distortion domain and effective rate balance were frozen
prospectively before this candidate. Presets, deltas, filters, ordinary
refinement, external thresholds and safety ceilings are unchanged. Imported
source YUV stays live through both trials; bounded reset and a third chosen
analysis restore unfiltered prediction state before emission. No additional
full-frame YUV/RGB/record allocation is introduced.

Owned WASM SHA256:
`0c41ebe8fb81dd0447e64e217cdaf0d1bcedec87d6562818ad688cfbb1f0953b`,
234792 raw / 59951 pinned-Node gzip bytes, max192MiB linear. Product-specific
provenance is regenerated with this tree's README and builder:
`26e269e027548c785cf76215473c86ea2484be457ed342c8d7db1add29ebada5`.
Generate/check reproduce the exact source-lane binary. Product host, Worker,
native routes, mux/timing/output ownership and aggregate limits remain intact.

At engine04b and clean harnessd1f4ca07, exposed81/81 and remaining426/426 passed
the unchanged joint gates. Coordinator independently reconciled all507 unique
conditions, input/dimension/preset and shipped-primary payload identities, and
recomputed every PSNR/SSIM/size decision. Summary hashes:

- 81: `0cec07bc51e8f5084f30c82575b19c1cbbe154afadc49b4fa066a2e1ac72c3e9`.
- 426: `9553698699ad6f61924ac2c23d5c275d7a55c85b53ef051976f962141cdde846`.

All V1–V9 inputs are exposed regression. Parent9c's first freshV9 remains
rejected59/60; new04b's regression pass does not erase it. V10 is a separate
prospective source freeze at that checkpoint. Its subsequent first evaluation
rejected58/60; that result and the later conditional-luma source preparation are
tracked in [#501](https://github.com/PiesP/wasm-motion-converter/issues/501).
The tables and hashes on this page retain engine04b identity. Rust126 default plus
15 explicit independent decoder cases, fmt/Clippy, reproducible WASM, compiled
ABI48 and final source/resource reviews are bound to engine04b. Product focused
host/memory/build/contract/cohort/animation tests passed77 cases after import.
These are engineering gates, not actual Windows or whole-product acceptance.

The maintained large-only ABI engineering probe at04b encoded the frozen
4096x2048RGBAq85 input into6461553 raw bytes (above the retired4MiB prototype
cap), SHA256 `e31c1e3cfc324209fadde156bf5733ecb53b2794432d99ad99eb9a9e89033f62`.
Native VP8 and libvpx decoded it consistently. Observed owned linear capacity
was100466688B. Large-case lease/cancellation were NOT_RUN by that selector;
do not inherit small-case checks or claim browser/GPU peak or timing from it.

The post-run timing tools now join15 actual controller attempt roots to their
physical payload bytes, exact source-bound distributions, collected result and
environment hashes. Initial producer-path, missing-payload and private-JSON
error findings are preserved and fixed; independent follow-up review has0open.
Fourteen maintained pure unit tests passed after product integration. Synthetic
tests and retained non-V8 payload admission do not constitute a V8 campaign.
No per-timed-call instrumentation requirement is added to the program; final
assessment must correlate actual forced-route/source and outside-clock
functional evidence at its stated scope. Source-bound V8 copy/capacity evidence
and missing hardware observations remain open, as do all other acceptance gates.

Fresh quality, clean final product build, forced software main/Worker/browser
animation/ICC/temporal checks, balanced first/warm latency, active Stop/recovery,
resource/platform acceptance and eventual dependency/asset/offline/update/provider
reconciliation remain required. Prior4c CI/security and16d Windows results keep
their actual tested source identities. Real Firefox website adapter and actual
Safari/mobile coverage remain unverified. Program #501 remains active.
