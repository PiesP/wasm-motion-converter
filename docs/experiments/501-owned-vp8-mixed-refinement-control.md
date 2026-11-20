# #501 mixed q60 display-refinement ablation: static candidate

## Hypothesis and retained controls

This point isolates post-selection display-RGB/SSIM coefficient refinement in
the existing eligible `mixed_y1_ac` q60 profile. It does not claim that
refinement caused the remaining fidelity or size failures. The earlier UV DC
`-9` source `3c6a163c71e9dabe71c962877846fa520eb766d6` passed 48/50
exposed rows. Actual frame 38 used 33,469 raw VP8 bytes against a 33,402.5-byte
limit, and frame 76 used 12,014 against 10,815. Its original-reference frame
76 PSNR delta was -1.189932 dB, below the retained -1 dB floor. The later
DC-zero point lost fidelity, filter-level-zero passed only 47/50, and 6/8
luma-bin pruning left frame 76's raw and decoded bytes identical to the `-9`
point. Preserve those separate receipts and their source identities.

A new diagnostic compared actual RGB frames 57 and 76 after color import in
the Rust leaf with a pinned native libwebp `6c484` source counterpart. All six
visible Y/U/V plane hashes matched, with maximum difference and squared error
both zero. Report SHA-256:
`56dd7a559d5365d66cd15cfafd4c5af7f00e0515561d63b1248ce0750daa0275`;
root audit SHA-256:
`8cf9a9484cae1887d865e198c4a2c279ae4ef7137abb76e5d69a05b5f547d7c4`.
This is neither a shipped comparator binary/source or WASM parity proof nor a
verified browser/original-reference color interpretation. It motivates a
separate residual/refinement experiment without identifying the cause.

## Single bounded change

For `mixed_y1_ac == true`, synchronous and resumable analysis pass no original
RGB into the post-selection single UV refinement and assign zero additional
joint-refinement quota. The existing bounded I16/I4/UV mode selection, its
source-YUV distortion and rate estimates, selected-mode coefficient work,
reconstruction, contexts, all AC/DC coding, and exact frozen output path remain.
The existing Y1 AC 5/8 zero bin, UV DC `-9`, UV AC `-15`, filter level 6,
input conversion, frame cadence, ABI2 contract, and resource ceilings remain.
Other profiles keep their refinement behavior. The high-chroma-loss profile
retains its separate completed-trial RGB scoring and bounded reset.

This is one static ablation. Quality may worsen, and no speed or quality pass
is predicted. It does not include DC-zero, 6/8 luma pruning, filter-zero, or
M3 batching changes. The patched `wasm-webp` stays the production primary.

## Verification and adoption boundary

The first required engineering checks are focused mixed-profile and excluded
profile Rust tests, full ordinary crate tests, explicitly enabled independent
native VP8/libvpx decoder tests, formatting, and Clippy. Regenerate and audit
the owned WASM provenance, rebuild independently, verify prebuilt identity,
and run compiled ABI2 engineering cases before a frozen source-bound measurement.
These checks have **not run** for this static candidate.

Keep all 45 tuning rows and the five exposed actual-browser-RGB rows, with
per-row PSNR at least primary minus 1 dB, SSIM at least primary minus 0.01,
and raw VP8 bytes at most `max(1.25 * primary, primary + 128)`. Keep the five
separate original-reference PSNR and SSIM floors. Do not update golden hashes
or thresholds to make a result pass. The full 687-condition exposed screen,
fresh media, full-animation decode, prepared-Windows product acceptance,
performance, resource, lifecycle, and delivery gates remain independent and
unrun for this candidate. The coordinator owns the source freeze, measurements,
and publication.

## Engineering checkpoint

Pinned Rust1.99.1 fmt/check, focused mixed-profile tests,164 ordinary native
tests,17 explicit independent-decoder/property tests and all-targets Clippy
with warnings denied pass. Maintained WASM generation, byte-identical
independent rebuild, prebuilt verification and48 compiled ABI2 cases pass.
Direct static review found no actionable finding. The new native control
compares with the test-only unrefined path, not an independent old binary or
per-plane AC/DC oracle; independent decoder fixtures retain their actual scope.

Module `88bd06890d641ca67aba816b1502db31188bcba9c2dddbc2c420a3035f941015`
is246720 raw/81997 Node gzip level-9 bytes, with initial
1114112/maximum201326592 linear bytes and zero new imports or dependencies.
All28 source pins and the artifact were independently rehashed. Provenance:
`27ae471967d3b91f6e918b69b20a29990e30beeb14e4d59d880624bc4bf455f7`.

No quality/size, product performance/resource, browser, freshV13 or delivery
acceptance measurement has run for this point. Freeze clean signed source
and exact module before the same exposed50 plus five original-reference
controls. Full source-bound product qualification remains required.
