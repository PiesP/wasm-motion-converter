# #501 mixed q60 display-refinement ablation result

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
The engineering checkpoint below records these checks on Rust 1.99.1.

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

## Exposed screen result

The signed implementation was measured at `5aff1357b3cbc2da95f99f2d1798b350a37e22c7`
against the shipped patched wasm-webp module `4d438a73`. The frozen lock
was `eeccae7df4118e285db7f8dc773e2c45d9f16c592e4585fbfa49d5392007e2b2`.
All 45 tuning rows passed. Of the five actual q60 browser inputs, all passed
input-relative PSNR and SSIM, and three passed the raw VP8 size limit.
Frame 38 used 33,554 bytes against 33,402.5 allowed. Frame 76 used 12,028
against 10,815. On the separate original-reference comparison, frame 76
missed the PSNR floor with a delta of −1.183832 dB. All five passed SSIM.
The five-row result digest is
`0145c05ab69cc320299003ce61c5618e7bcc8eb38fe4c50684c15eef07a7f35b`.
Native VP8 and libvpx independently decoded the 100 saved streams to
matching RGB. The 45-row paired decoder receipt is
`02828b51610ef01f61c01afa8993d353f9f8cb840d19e17c429f62867e71496e`.

**RETAIN_CURRENT.** The ablation reduces the fixed-input frame 76 step count
from 103,310 for the UV DC −9 control to 57,857. Whole-product speed remains
unmeasured for this candidate. Its size and original-reference failures rule
out escalation to the fresh cohort or replacement of the production fallback.
