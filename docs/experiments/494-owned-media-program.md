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
without changing runtime behavior. Later confirmed conflicts and their resolutions are recorded in the coordinator
ledger; this initial inventory does not claim a repository-wide audit.

## #496 stage 2: prospective retained-state experiment

Admitted after stage-1 source was frozen, while its independent schedule remains
in progress. Stage-1 `f21c1cf0` and all samples stay immutable. Stage 2 evaluates
retaining compact indices/palettes and fusing compaction/hash in Rust. The
qualified predecessor remains f2d6bf67; the new data-flow premise is an explicit
avoidable N-byte index copy out for each mapping and N-byte copy back for each
image-data write. Duplicate elimination and delay splitting can change these counts.

Reserve two protected N-byte index slots at B+max(4N,N+LZWbound(N)). This
also keeps compressed output disjoint for tiny frames, where its bound can
exceed the RGBA arena. The
current transient index uses the first N bytes; pending and deferred predecessor
use protected slots. Promotion costs one internal N-byte copy. Direct LZW from
a retained slot must never overwrite the current transient index; compression
output remains disjoint within the existing admitted frame arena. Palettes and
global mapping need bounded separate metadata and generation-checked handles.
Hash remains only a prefilter before exact expanded-color equality. Preserve
first-occurrence palette compaction, equal-RGB behavior, all tie/order/rounding,
TS presentation timing, frame selection and writer byte layout.

The materiality target is elimination of N bytes per mapped frame out and
N bytes per image-data write back on the retained route, while acknowledging
the internal promotion copy. gifRetainedIndexMapping and gifRetainedFrameWrite
profile sample counts distinguish these actual route observations. No physical-peak saving is presumed: linear capacity grows by
roughly 2N while host retained indices disappear. With the current heap base,
new rounded capacities at540-square/720-square/1080p are7,536,640/8,912,896/
18,219,008 bytes, within existing dimension-adjusted limits. A4K retained layout
would exceed its existing bound. Keep the stage-1 JS-index route for dimensions
whose retained layout cannot be admitted; do not increase the existing linear
or aggregate ceilings, narrow accepted inputs or change quality. Both routes
require exact byte/output and lifecycle checks, including forced admission-edge
coverage. A small palette snapshot (<=768 bytes) is allowed if it makes borrowed
view ownership explicit. Acquire borrowed output only after any growth and
consume synchronously before another module operation.

Before candidate comparison freeze its exact source/build/fixtures/route and
copy/lifetime accounting. Use the same owner-primary/default/small first/warm
five balanced attempts and max(5%,20ms) median no-regression screen, independent
output oracle and <=500ms active cancellation/recovery. Stage-1 samples are not
stage-2 measurements. ADOPT only if exactness, resource fallback and material
crossing reduction plus regression gates pass; otherwise retain qualified
stage1 with the failed candidate and an explicit resume condition. Direct
VideoFrame ingress remains a separate conditional experiment.

## #495 stage 2: bounded selected-input index reuse

Admitted after initial parser differential correctness at62f5e771 (29 frozen
inputs,505 packet traces,145 verified seeks). This is a separate implementation
and measurement stage. Live source confirms metadata analysis currently runs on
the main thread; there is no existing metadata Worker to reuse. A conversion
Worker receives a structured clone of the selected immutable Blob. Do not claim
cross-realm linear-memory reuse or retain a metadata codec instance while idle.

Keep one <=8MiB logical index snapshot, keyed by the exact selected Blob object
and a selection generation. Replacement/analysis cancellation clears it and
rejects late publication. A bounded first/last64KiB SHA256 token supplements
this identity; it is not a complete content hash. Each conversion transfers one
independently owned copy of the master snapshot, checks generation/source size/
token before import, then imports versioned fixed-width records in bounded
host-task steps into fresh conversion-owned WASM. No raw Rust heap snapshots.
CRC and complete field/offset/extent/time checks precede ready publication.
Oversize prospective export or an unavailable matching cache is an ordinary
pre-use miss and takes the normal parser route. Malformed imports, OOM, abort,
traps and post-bootstrap errors remain terminal; never retry a failed job.

Charge the idle master, per-job copy, imported index and any still-live import
source separately. They are not extra slots inside already-counted WASM
capacity. Preserve32MiB live metadata/index,64MiB linear capacity and128MiB demux
envelopes including growth overlap and outstanding/retired source reads. Index
import must prepare required reconstructed-packet scratch before external ready.
The selected idle state retains no demux WASM or codec scratch peak.

Before performance comparison freeze sources/builds and metadata/export/import/
seek/whole-product workloads. Five balanced first/warm attempts per variant,
max(5% baseline median,20ms) no-regression per declared condition, raw samples,
range/MAD and <=500ms active cancellation/recovery remain required. Report
source reads, copied bytes, snapshot live bytes and reserved WASM capacity
separately. Exact config/packet/seek/output and source replacement/late-I/O tests
must pass; reduced read count alone does not qualify production adoption.
