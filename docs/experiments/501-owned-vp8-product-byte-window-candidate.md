# Product filtered-refinement candidate: acceptance pending

Historical product snapshot at4c3c9995. The subsequent
[completed-RGB profile candidate](501-owned-vp8-product-completed-rgb-candidate.md)
records the new engine import without upgrading this point's rejected result.

This unmerged engineering candidate imports the owned Rust source from
`9c308303c5cc0da8d2be0a45355275a24e4aaf59`, following the historical
[product refresh](501-owned-vp8-product-refresh-candidate.md). Production master
still uses patched wasm-webp. No runtime adoption or dependency removal is claimed.

The owned WASM SHA256 is
`caf1d2c21de43a34581cae079261073d3c49b7c2df3c324734bf61e3ead81515`,
234505 raw / 59867 gzip bytes with the pinned Node gzip method. Product-specific
provenance SHA256 is
`9127bcf71ea4423f406c7d1b27ae59a042f5bf8cb06244cb1ad358c49809461d`.
Both generate and reproducibility-check builds reproduce this module. Every
recorded source hash matches; only the product README and product builder differ
from the source lane. Product-role documentation is preserved and provenance is
regenerated here rather than copied from the qualification tree.

The engine evaluates existing extended, captured mandatory and unrefined
variants using complete filtered reconstruction, while preserving unfiltered
neighbors for prediction/replay. The new selector permits a refined variant
exactly one byte above legal unrefined output only if its finite filtered score
strictly exceeds the best legal score within the unrefined byte bound. Two or
more extra bytes remain ineligible. This changes no preset, geometry, frame
selection/cadence, search budget, safety limit or external acceptance threshold.
See the crate README for bounded quality stages and resource charges.

## Source-bound evidence

At source9c308303 and qualification harness
`e1831ef5a26bec167869e4ecd0232e43adaf7ccc`, the exposed regression screen passed
78/78, then the remaining369/369. Coordinator reconciliation verifies all447
unique fixture/preset pairs, identical inputs and shipped-primary payloads,
and independently recomputes every PSNR/SSIM/size gate. Retained summary hashes:

- 78: `5d6e4da69a13090ad568d20f6b8466373b41ebebe38bf5839a677a954c28d028`.
- 369: `0a4143272df77c6618aadb3624fd3c6029fbb11f96fcc6f7cf6e5aeb35a6c12b`.

All V1–V8 inputs are exposed regression evidence. Parent0d0fa781 passed387
known conditions but failed its first fresh V8 evaluation59/60; that rejection
and its original thresholds remain intact. Bounded independent controls showed
that its existing69-byte refined payload passed the failed tiny7x1q85 condition
but was excluded by the old68-byte internal bound. This justified the uniform
prospective selector rule; no named-input encoder exception was introduced.
New9c passes that condition with69 raw bytes, PSNR18.815014dB and SSIM0.400781
against primary66 bytes,18.361630dB and0.400408. Size gate remains194 bytes.

On this product integration tree, maintained verify11/11 passed; five focused
host/cohort/animation unit files passed45 tests; three memory/build/Windows
contract unit files passed32 tests. The actual compiled module passed47 ABI2
engineering cases, including independent decoding, stale/leased publication,
actual analysis cancellation/recovery and filtered-copy cancellation. Compiled
log SHA256:
`5f2a5c8f83383ce591d68cab8479dbc89c307cf96b5396a1f270997de5db4d73`.
These checks ran before the integration commit and establish engineering
behavior, not a clean-source Windows acceptance build. Rust124 default tests,
15 explicit independent-decoder tests, fmt/Clippy and source review are bound
to unchanged engine9c; they are not newly executed product browser checks.

## Remaining gates

Fresh V9 inputs were being prepared at the engineering checkpoint above.
The subsequent first fixed-pixel evaluation at engine9c and harness39852d52
completed59/60 and rejected this candidate for adoption: chroma-edge407x277q60
SSIM-.074856 missed the unchanged-.072949 floor; PSNR and size passed.
Summary SHA256 is
`c2881b591466e910d1aab65e6ac313767250b19eb02ed302592b0912492ff468`.
All V9 inputs are now exposed, bringing known conditions to507. The failure and
prior447-pass result remain separate; no product acceptance is inferred.
Controlled existing-profile diagnosis continues before a general correction.
Before adoption, qualify the final clean product source through
the maintained guarded Windows main/Worker paths, independent full-animation
checks, actual active Stop/recovery, large admitted inputs, balanced whole-product
first/warm timing, resources and current browser coverage. Preserve the exact
prior distribution and existing numerical gates. A Node step or accounting
capacity observation is not browser/GPU peak or product performance.

Existing main/Worker host interfaces, timing/mux/output contracts, resource
broker, quality intent and useful native routes are unchanged by this import.
The production dependency, legacy loader/fallback and executable assets remain
until all required gates pass. Source-bound CI/security, protected integration,
automatic provider identity and served bytes require separate final reconciliation.
Real Firefox product adapter and actual Safari/mobile coverage remain unverified.
Program #501 remains active.
