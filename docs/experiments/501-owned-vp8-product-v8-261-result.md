# #501 first product V8 campaign: stopped partial result

The installed Edge campaign ran source `261cb630616062e020a1b5c43f64ddadb9a1f0b9`
with owned module `e918f3016451b60f04dfa551e5ae57820bcbc65c8c8834f01c8426b72355e584`.
The original prior source was `be35f5fa89a60189475fe2ef7fd446e9fa18cef4`,
core `4638d703`, and patched legacy WASM SHA-256
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
The fixed V8 input, settings and prospective gates are recorded in
[the V8 manifest](../../validation/windows/owned-vp8-v8.json) and
[the timing contract](501-owned-vp8-product-timing.md).

| Attempt | Prior first / warm | Candidate first / warm | Completed animation frames |
| --- | --- | --- | --- |
| Low, AB | 17.791 / 17.276 s | 85.652 / 89.968 s | 77 on both sides |
| Medium, BA | 26.953 / 27.144 s | 135.848 / 132.372 s | 115 on both sides |
| High, AB | 44.802 / 44.995 s | First attempt timed out; warm NOT_RUN | Prior 192; candidate no completed output |

The existing 180-second download-ready observation timed out during high
candidate encoding. Saved DOM showed Converting, 89%, frame 146/180 and no
visible product error. This does not establish the cause or eventual completion.
The wrapper stopped; attempts 4–15 were NOT_RUN. No automatic retry, signal or
alternate backend was used. All 17 started host observers exited successfully;
that alone does not qualify host-neighbor load. The required balanced medians
were not formed. The campaign is **STOPPED / PARTIAL**, never a performance PASS.

Both actual timed routes were main software, with zero Worker starts. The prior
main facade embeds its own Emscripten factory; the original probe patched only
the separate Worker factory. Its zero copy/capacity counters mean **UNKNOWN**,
not zero physical copies. Subsequent validation changes pin and observe both
factory roles. Their new runtime execution needs separate evidence. Per-step
probe overhead remains an unmeasured hypothesis, not a subtraction from these
times or an assigned explanation of the regression.

Raw receipts, failed roots and original unsuccessful collection/cleanup fields
remain retained outside Git. Read-only follow-up found no matching failed-root
processes/tasks, and later no receipt-bound guest Node/browser PIDs. Those
observations do not retroactively change failed transport receipts to PASS.
The issue ledger contains [the campaign disposition](https://github.com/PiesP/wasm-motion-converter/issues/501#issuecomment-6902750596).

The separate source-261 retained-owner run observed seven main checkpoints
with zero live mutable owners and a discriminating retained/released control,
but its whole result is **UNVERIFIED**: the harness expected a UI conversion
Worker that the current WebP UI never creates. Preserve that failure; the
[corrected protocol](501-owned-vp8-owner-retention.md) distinguishes main UI
acceptance from direct compiled Worker ownership and termination. Neither a
single functional observation nor a reachability result waives the missing
product, platform, resource or delivery gates.

The later [release-profile](501-owned-vp8-throughput-profile.md) and
[exact-pruning](501-owned-vp8-exact-rdo-pruning.md) experiments are new candidates
with their own binary identities and checks. Their Node diagnostics do not
replace this failed product evidence. Production wasm-webp remains retained;
no runtime removal, protected merge or deployment qualification follows here.
