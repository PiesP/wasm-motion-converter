# Owned VP8 product functional evidence

Outcome: **PARTIAL; no runtime adoption/removal**. The frozen M2 candidate remains
rejected43/45 on corrected-v3 size gates; see the [quality result](501-owned-vp8-v3-result.md).

The guarded Windows run `501-vp8-smoke-20261115-03` used clean product source
`da576c1fd2e98eeb15572113d92a0eb0e72eb2c3`, core
`4638d703806b38734430a761104ee73512cbdf5c`, owned WASM SHA256
`9c5247dc251aaabf79807c930c6300379d7c9e662ddcca08e363f5a9e578167f`,
and the pinned prior distribution from `be35f5fa89a60189475fe2ef7fd446e9fa18cef4`.
The prepared existing Windows11 VM ran installed Edge157.0.4341.57 desktop,
Node26.13.1, with the controller's exclusive guard. Unrelated background
processes, VM configuration and power state were preserved.

The forced software functional scenarios passed:

- Main-thread ABI2:5710 actual steps,10 successful frame begins, instance retired.
- Direct conversion Worker:16 encoded frames,4848 actual steps and one host-task
  yield; actual linear capacity1310720 bytes, reserved capacity8454144 bytes.
- Active main-thread Stop:6.355ms to idle after13153 observed steps, no cancelled
  publication; a new request succeeded in the same document.
- Controlled post-real-step RuntimeError: failed instance retired, no publication
  or automatic retry/backend fallback, then explicit UI Retry succeeded with a
  fresh instance in the same document. This is controlled error injection, not
  evidence of a naturally occurring codec trap.
- Invalid input followed by a valid same-document request also recovered.

The task-owned transport collection and guest cleanup passed, with no retained
failed guest root. The initial failed smoke and older successful smoke remain
separate historical receipts; their source identities are not promoted to this run.

Independent verification at the same clean source binds bundle, original report
bytes (including any PowerShell UTF-8 BOM), collection, source manifests, input
and saved output hashes. All28 declared saved animations, including explicit
trap-retry output, decoded with both FFmpeg native VP8 and separate libvpx with
identical RGBA frames. Geometry, frame order, timestamps/holds and12 paired ICC
identities were checked. FFmpeg7.1.5 and exact verifier/parser hashes are recorded
in `m4-animation-smoke-03-oracles/verification.json` under the private task artifact
root. The source run remains under the private Windows acceptance runs directory.

This single SMALL invocation contains24 diagnostic timing samples. It does not
establish five balanced per-condition medians, large-video performance, temporal
perceptual quality, browser/GPU memory peaks or full platform acceptance. Managed
Chromium/Firefox/WebKit SDK tests added later require their own execution and
source binding; managed WebKit is not real Safari. Actual Firefox product adapter,
real Safari/mobile and broader coverage remain UNVERIFIED. Production master
continues to use wasm-webp until all required qualification/removal gates pass.
