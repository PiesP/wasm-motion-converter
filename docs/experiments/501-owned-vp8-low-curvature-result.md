# Owned VP8 low-curvature fixed-pixel result

Related issue: [#501](https://github.com/PiesP/wasm-motion-converter/issues/501).
This candidate passes the frozen codec quality/size screen. Product adoption,
whole-product timing, browser lifecycle/resources and runtime removal remain held.
Production master still uses the pinned patched wasm-webp comparator.

## Source and prospective decisions

Engine source `a83f5b694a37db7770c3b0daae4c8376a88b955d` contains independently
reviewed Rust source `0e49dfcd97d11fc97a177b10cb6b086ab3a3458a` and its generated
WASM. Module SHA256 is
`e918f3016451b60f04dfa551e5ae57820bcbc65c8c8834f01c8426b72355e584`:
236,365 raw bytes, 60,652 bytes with the pinned gzip recipe, 192 MiB maximum
linear memory. Product provenance is regenerated from this checkout; its README
and build roles differ from the standalone engine without changing Rust bytes.
The product main and Worker adapters keep their existing ABI2 and animation mux.

The earlier `a5a21bf6` allocation failed seven q60 size conditions (620/627),
although every PSNR/SSIM gate passed. Its complete failed outputs remain retained.
A registered source-only probe examined exactly eight exposed inputs, verified
input hashes and original imported YUV, and found that all-Texture classification
mixed sparse curvature with dense detail. It did not inspect V12 or encode data.

The next rule was registered in
[comment 6899513103](https://github.com/PiesP/wasm-motion-converter/issues/501#issuecomment-6899513103)
before source changes. Normal non-neutral all-Texture q60 frames receive R4 only
when each padded source Y/U/V plane has mean absolute within-tile horizontal and
vertical second difference at most the existing classifier cutoff 2. The maximum
classifier rule and class IDs remain unchanged. Counts are 448 Y and 96 U/V
terms per macroblock, excluding tile boundaries; sums use bounded u64 arithmetic.
This runs inside classification, with no extra source pass or frame buffer.

R4 lowers the coding qindex by four, signals Y1 DC/Y2 DC/Y2 AC deltas +4 and UV
DC/AC -15/-7, and preserves original qindex rate weights. Y1 AC necessarily gets
finer. Other q60 frames retain the pre-R4 allocation. The q75 medium-textured
policy retains its prior source-error condition and luma allocation; non-neutral
eligible frames use UV DC -11 and UV AC -7. q85, geometry, selected frames,
cadence, source conversion, search budgets and external thresholds are unchanged.

## Separate executed campaigns

The primary comparator in both campaigns is the shipped patched wasm-webp WASM
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
Every condition requires PSNR at least primary minus 1 dB, RGB SSIM at least
primary minus 0.01, and raw VP8 bytes at most max(1.25 times primary, primary+128).
No settings, source pixels or thresholds changed during either campaign.

| Scope | Actual harness | Joint result | Independent audit SHA256 |
| --- | --- | --- | --- |
| Exposed regressions: 209 inputs x3 qualities | `e8067062601e4ea419f6970450efcf523b4e118b` | 627/627 | `38bce073bb0592fd3bc011a5c663f955aed8e8c1602553dcd2a76857694498ff` |
| First V12: 20 prospectively frozen inputs x3 qualities | `6e0b1e0766d610cdf51c5ab0da5e193ea0ed6514` | 60/60 | `65a5b5b8f0069550aa8eeaf542a17a791f63b653f8d86a0210796aea33540696` |

These are two campaigns, not 687 new held-out conditions. All conditions were
new executions. Audits independently checked complete unique inputs, primary
and module identity, geometry, metrics/gates and duplicate-hold bit identity.
The earlier seven size failures and original V11 photo PSNR failures pass on
exposed inputs; historical rejections remain rejections.

V12 used [the frozen source contract](https://github.com/PiesP/wasm-motion-converter/blob/6e0b1e0766d610cdf51c5ab0da5e193ea0ed6514/docs/experiments/501-owned-vp8-v12-source-freeze.md):
two new CC0 originals, four disjoint photo crops, thirteen synthetic inputs and
two unused video frames plus one intentional hold. No collision with the 209
prior input hashes existed. Root reproduced the full manifest byte-for-byte
before first encoding; generator `acb0eae5...`, manifest `56ce9409...`.
[First registration](https://github.com/PiesP/wasm-motion-converter/issues/501#issuecomment-6899825842)
preceded the only complete 60-condition run. Results SHA256 is
`a7b4225fb4422fbf824827d83bb75a6da1bd3606c03d18abbd02c10dc1825d69`.
V12 is now exposed for future corrections.

## Engineering checks and remaining limits

At the reviewed Rust source: 135 native tests and all 16 explicit independent
native VP8/libvpx reconstruction tests passed, along with fmt/Clippy. Offline
WASM generation/reproduction and actual compiled ABI2 checks (48 conditions,
leases, cancellation and new-instance recovery) passed. These identities remain
separate from integrated product checks and exact-head CI.

Node observations are engineering accounting, not browser/GPU peak or product
performance. Exposed627 maximum retained linear capacity was 104,923,136 bytes;
input/output copies 40,262,000/225,569. A 78.367308 ms step at phase4/stage0 on
fresh11-large-admitted q60 is retained without a proven cause or fix. V12 maxima
were 104,988,672 retained bytes, 40,241,796/278,914 input/output copy bytes and
4.325345 ms observed step. No physical zero-copy claim follows. All q60
classification may examine 640 terms per macroblock, including ineligible
frames; whole-product cost remains unmeasured.

M4 must still force the actual compiled owned route and verify full animations,
visible geometry/color/ICC, timing/order/loops/holds, large inputs, repeated jobs,
active Stop and same-document recovery, balanced first/warm timing and resource
attestation. Current real Firefox website automation is unsupported; actual
Safari/mobile remain UNVERIFIED, and managed WebKit is not Safari. Apply the
existing policy to each concrete gap while continuing supported work.

M5 still requires removal of reachable legacy runtime/loaders/chunks/assets and
classification, a pinned development oracle where needed, executable delivery,
CSP/MIME/offline/update/notices checks, protected integration and provider/served
byte reconciliation. JavaScript/Actions CodeQL does not establish Rust coverage.
No completed runtime removal or product adoption is claimed here.
