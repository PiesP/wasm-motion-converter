# #501 eligible Y1 AC zero-bin candidate: unmeasured

## Retained control and one calibration

The rejected selected-mode I4 AC-neighbor point closed at signed commit
`13d1df9376c3180639867179f5e360c3bc1be2ef` with executable module
SHA-256
`206cf945b56ca26d1cb11d1636cb80a4a623036691a8a6d901c41bd79910f223`.
Its measured source was `fece06745eed79d75433f6916b265ef5ad7fed3d`;
the later commit only refreshed README-bound provenance after the failed
screen. All 45 tuning rows and five exposed actual-browser-RGB PSNR/SSIM
rows passed. Actual row 38 exceeded the raw VP8 size cap by 1,069.5 bytes,
so the joint result was 49/50 and the point was rejected. The 45-row paired
audit matched both native decoders to retained RGB hashes. Keep that source,
module, failure and paired receipts separate from this candidate.

For the existing eligible mixed q60 Y1 AC profile alone, this candidate
widens the encoder's marginal AC zero bin from the canonical half step to
five eighths of the current segment Y1 AC step. After canonical nearest
quantization, an original `+1` or `-1` Y1 AC level at position 1 through 15
becomes zero exactly when
`8 * unsigned_abs(transformed_coefficient) < 5 * Y1_AC_step`.
Equality keeps the canonical nonzero level, and both signs use the same
integer rule. Only the marginal unit level may change; all other levels,
including DC, use canonical nearest rounding. Wide products admit extreme
test magnitudes without overflow. The eligible segment Y1 AC steps are
`[14, 26, 40, 40]`, giving first nonzero transformed magnitudes
`[9, 17, 25, 25]`. This is one fixed point, not a threshold sweep.

The existing eligibility still requires quality 60, non-neutral imported
chroma, no high-chroma-loss profile, at least two active source segment IDs,
and the existing padded-plane low-curvature condition. Excluded profiles and
qualities 75/85 retain canonical decisions. The rule applies before both
I16 Y1 AC reconstruction and I4 prediction-mode scoring/reconstruction.
I4's selected-mode AC-neighbor search still runs on its chosen baseline.
Y1 DC, Y2/WHT, UV, signaled qindices/deltas, decoder inverse dequantization,
filter, lambda, coefficient-context update rules, statistics/emission logic,
skip rules, ABI, frame cadence, geometry and resource ceilings remain unchanged.

The mixed allocation already signals a UV AC delta of `-15`. A global
qindex increase of two would need `-17` to preserve UV AC quantization on
nonclamped segments, which the signed header rejects. This encoder-only Y1
AC decision keeps the existing signaled steps instead of silently changing
UV or another plane. Different coefficient choices may still change I16/I4
modes, reconstructed neighbors, skips, and later blocks. There is no byte,
quality or performance pass prediction.

## Verification and adoption boundary

Focused Rust tests must cover both signs and the exact below/equal/above
integer threshold at each eligible step, default nearest behavior for other
qualities and profiles, extreme magnitudes, unchanged DC/Y2/UV and signaled
header, source-bound I16/I4 reconstruction, mode-score and pruning parity,
contexts and skip propagation. A bounded
FrameEncoder fixture must show a final selected Y1 coefficient changing in
an eligible mixed-q60 block and remaining canonical in an excluded q75 block,
using the selected predictor and actual signaled steps in each comparison.
Retain synchronous/resumable/repeated-job, native `vp8`/`libvpx`, resource,
partition and cancellation gates. Then
complete locked Rust validation, scalar WASM provenance and compiled ABI2
before the frozen 45 tuning plus five exposed actual-browser-RGB screen and
paired decoder audit. Only 50/50 permits the full 687-condition exposed
screen. Fresh media, Windows product acceptance, lifecycle, performance and
delivery remain separate gates.

Row 76 of the rejected control had only about 0.411 dB PSNR margin and 42
bytes of size headroom. This zero-bin candidate can alter entropy context
and visible RGB quality; no integrated activation frequency or acceptance
result is claimed before source-bound measurement. All previous failed and
successful receipts retain their own source identity.

## Focused engineering validation

The first locked/offline Rust pass passed all five `y1_zero_bin` tests,
including a bounded actual mixed-q60 FrameEncoder witness whose final
selected I16 Y1 coefficients and reconstruction reflect the calibrated
decision, and an excluded q75 witness retaining canonical coefficients.
First-mode parity, pruned/exhaustive I4 search, independently recomputed
selected score, and existing mixed-profile synchronous/resumable/repeated
frames each passed their focused test. This proves activation for the test
source; it does not measure activation frequency in the frozen codec screen.

The initial formatting check failed on layout in the new test code and passed
after formatting. The first five-test run passed four; the skip/context test
incorrectly inspected the first 4x4 tile's vertical context after later
tiles had overwritten it. Its fixture now uses the final tile, and the
affected five-test group passed on rerun. The first failure receipts remain
preserved. The locked/offline ordinary crate suite passed 160 tests. All 17
explicitly enabled independent native `vp8`/`libvpx` decoder tests passed
on source-file SHA-256
`255274943142c85bd7addf656214289be7d6fcad76d4a8122e949d8e2aeb15eb`.
All-targets Clippy with warnings denied initially flagged
a `clone()` on the test-only `Copy` `Macroblock`; that line was corrected
without a production-code change. Clippy, all 160 ordinary tests, and
formatting passed on corrected source-file SHA-256
`44873b0d4c2da59a7376bcc466c7325e95ce2e4501c0ce35715b84d6d24817cb`.
The 17 decoder results are reused
from the immediately preceding source with only that test-line difference;
they were not rerun on the corrected source.

## Source-bound WASM engineering

The maintained generator produced module SHA-256
`fc13fa5fcc7b07a7922e64489220d9e1073588947216d3dba9fbca498eb64347`
from the corrected source and README. A separate rebuild matched the recorded
module byte for byte, and prebuilt verification passed. The compiled ABI2
engineering check passed on pinned Node 26.13.1. An independent audit matched
all 28 source inputs to the generated provenance manifest and the preserved
pre-generation copies. It also checked the module digest, 247,450 raw bytes,
82,767 bytes at gzip level 9 with mtime zero, and the declared 1,114,112-byte
initial and 201,326,592-byte maximum linear memory. The signed parent module
`206cf945b56ca26d1cb11d1636cb80a4a623036691a8a6d901c41bd79910f223`
was preserved separately before generation. The raw command, output, error,
exit, input snapshot, and parent-artifact receipts are retained under the
`y1-ac-zero-bin-01/wasm-engineering-01` evidence directory.

These checks establish the candidate artifact's engineering identity and ABI
behavior. The frozen codec screen, paired decoder audit for this candidate,
full exposed regression, fresh media, browser product, performance, and
delivery gates remain unrun. Earlier native decoder evidence retains its
actual preceding source identity; neither it nor this engineering pass is a
codec quality result.
