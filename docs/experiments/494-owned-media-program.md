# Owned media program: prospective execution contract

Coordinator: #494; milestones #495, #496, #497. Frozen initial source is
`f2d6bf67e4a1e3509e92b439901acb5a922b6914`, core
`4638d703806b38734430a761104ee73512cbdf5c`. #492/#493 is completed and
qualified; its existing samples, criteria, failures and artifacts stay immutable.
This contract precedes new candidate measurements. Issue #494 owns live status.

## #495: bounded demux

Freeze the patched MediaBunny 1.65.2 oracle (lock integrity and patch digest),
source-bound generated fixtures and normalized track/config/packet traces before
comparison. Cover classic/fragmented MP4 and MOV, AVC/HEVC configurations,
B-frame decode order and edit offsets; WebM/Matroska VP8/VP9/AVC/HEVC, cues and
cue-less clusters; MPEG-TS PAT/PMT/PES, AVC/HEVC, timestamps and carry. Record
actual oracle success rather than treating an admitted filename as codec proof.
Use existing rotation/aspect/color/VFR/trim fixtures, short clips, malformed and
resource-limit fixtures, independently decoded output and FFprobe packet data.

A compiled owned core must retain first-video-track selection, decoder fields,
payload bytes, decode order, packet timestamps/durations and verified keys.
Host-owned bounded Blob ranges feed resumable bounded work steps; contiguous
payloads remain host ranges. Index, metadata, reconstructed scratch, outstanding
reads and native chunk allowances require separate ownership and admission.
Preserve 16 MiB contiguous/packet, 32 MiB metadata, 64 MiB queued chunk and
128 MiB demux policy envelopes and checked logical-work limits. No synchronous
full-file parse or per-sample JS object expansion. Initial parser correctness
and later InputSession reuse are distinct stages. No production route switch
or removal until both metadata and conversion pass all required families.

Dependency removal requires no regression beyond max(5% baseline median,20 ms)
in each declared first/warm metadata/seek/conversion condition; five balanced
interleaved samples per variant/condition, raw samples/range/MAD. First capture
correctness/read/copy/index/capacity telemetry, then freeze the exact performance
workloads before collecting comparison timings. Missing private input affects
only its cohort. Partial parsers remain PARTIAL and cannot close removal.

## #496: exact GIF data movement

The first candidate removes the JS exact-RGBA scratch and its 4*W*H copy by
copying the checked pooled prefix directly into admitted WASM input and applying
the identical Bayer LUT/truncation/clamp there. One 4*W*H host-to-WASM copy
remains. The required material benefit is elimination of that copy and retained
JS scratch, corroborated by source and runtime counters/capacity accounting.
No claim of native/GPU zero-copy or measured process-peak reduction follows.

Preserve complete deterministic GIF bytes and independent composited geometry,
frame order, delays/duration and loop. Cover all presets, tiny/odd/larger frames,
flat/text/gradient/noise, Bayer coordinates/clamps/alpha/ties, palette compaction
and global reuse, differently indexed duplicate colors, pending/deferred/short
terminal holds, repeated jobs and failures. Writer/timing stays unchanged.
Pending and deferred indexes survive next input: do not reuse their arena until
dead; any Rust retention requires explicitly admitted protected slots.

Use the existing owner primary (medium/1/off), owner default (medium/.75/off),
and maintained small control (low/1/low), each first-use and same-document warm.
Five balanced/interleaved attempts per variant/workload/condition; baseline and
candidate sources/build/input/settings/cache identities frozen before runs.
Request-to-matching-download-ready includes initialization/copies/finalization;
saved-output checks and diagnostics remain outside. Each median increase must
be <=max(5% baseline median,20 ms). Active Stop-to-idle <=500 ms separately
for Worker and controlled bootstrap fallback, no cancelled publication and
successful same-document recovery. Existing byte/memory ceilings remain.
No additional runtime package removal is claimed by this milestone. Direct
VideoFrame ingress and deeper retained-index fusion need separate admission.

## #497: bounded VP8 feasibility

Start an owned zero-external-crate Rust/WASM keyframe encoder, bounded opaque
RGBA/BGRA + dimensions/stride to raw VP8. Validate actual compiled output by
independent decoding (16x16 solid, odd17x13 first), strict full-canvas geometry,
malformed/overflow rejection and repeated state. A solid/DC-only slice is PARTIAL.
Freeze owned pixel-fixture digests before comparison: text/UI, gradient, chroma,
photo/motion-derived, noise, flat and odd/larger cases at all q60/75/85 presets.

For production adoption, independently decoded candidate PSNR must be at least
baseline minus1 dB and SSIM at least baseline minus.01 on each lossy fixture;
size <=max(125% baseline,baseline+128 bytes). These are prospective screening
criteria, not a claim the different encoders produce identical bytes. Visual
artifacts and preset monotonicity/calibration also matter. Five balanced first/
warm attempts require each median <=baseline+max(10% baseline,20 ms), within
existing aggregate resource/output caps, without retaining extra codec peak
while selected/idle. Report source/reconstructed YUV, tokens versus recompute,
output and per-worker reservations separately. A clear early correctness/
quality/size/resource failure may complete the bounded experiment as
RETAIN_CURRENT with exact evidence and a concrete resume condition; do not
expand indefinitely or remove wasm-webp on a partial success.

Native VideoEncoder VP8 is a separate actual encode/decode probe, not an API
presence assertion. Record config/support, forced-keyframe bitstream/dimensions,
independent decode and quality/size behavior; numeric q60/75/85 equivalence must
be calibrated. Keep validated Canvas/native routes and owned animation timing/
mux. Required fallback removal needs full supported-browser evidence; missing
Safari/mobile is UNVERIFIED, with fallback retained.

## Final evidence and decisions

Separate execution status from ADOPTED/RETAIN_CURRENT/PARTIAL/DEFERRED/BLOCKED.
Use focused checks, final verify:full, exact-source CI/security and actual
prepared-Windows acceptance. Serialize interactive/performance environments
under the maintained ownership guard; no other execution's resources are
modified. JS/Actions CodeQL is not Rust semantic coverage. Protected merge and
automatic Pages source/provider/served-byte verification are distinct from
local success. Latest stable major support is unchanged; no legacy shims,
format narrowing, quality changes, new hardware or paid infrastructure.

Confirmed stale comments at initial f2d6bf67: decoder-service.ts:16 and
constants.ts:68 still named gifenc after #492; streaming-webp-encoder.ts:5-18
described the shared mux as wasm-webp-only. This branch corrects all three
without changing runtime behavior. No other confirmed conflict is claimed.
