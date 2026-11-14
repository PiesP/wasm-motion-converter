# Owned bounded local-video demux

Original MIT Rust implementation for dropconvert #495, coordinated in #494.
This crate has zero external Cargo dependencies. It parses the application's
admitted MP4/QuickTime, Matroska/WebM and MPEG-TS video tracks; browser WebCodecs
still owns video decoding. It is not a general media framework, audio decoder,
network/HLS client or replacement third-party codec wrapper.

## Source and regeneration

Use the pinned Rust1.99.1 toolchain and locked/offline build through
`scripts/build/build-owned-demux-wasm.ts`. `vp run build:demux-wasm` verifies the
checked-in source/manifest/ABI/asset without installing Rust; `:check` regenerates
and compares exact bytes; `:generate` deliberately updates the owned artifact.
The builder records the closed Rust source set, manifest, zero-dependency lock,
compiler/flags and import-free WASM digest. WASM is scalar, unshared wasm32 with
64MiB declared maximum memory. Ordinary Node/Pages builds use the checked asset.

The exact compiler commit and virtual checkout/Rust-library path mappings are
recorded too. Optional installed `rust-src` must not change inlined standard
library panic locations from `/rustc/<commit>` into machine-local sysroot paths.
The builder normalizes those locations with encoded compiler arguments, keeps
strict byte equality, and preserves isolated Cargo output plus both digests on
a comparison failure. Minimal CI and a local toolchain with `rust-src` must
reproduce the same artifact; changing checkout location alone is not sufficient
to exercise this distinction.

The pinned patched MediaBunny1.65.2 implementation is a development oracle.
Frozen synthetic inputs and normalized configurations/packet/seek traces are in
`test/fixtures/owned-demux`; the capture script also independently decodes them
with FFmpeg/FFprobe. Its source identity and patch attribution remain separate
from owned implementation and runtime-removal accounting. Matching one oracle
does not replace independent decoding, browser execution or malformed testing.

## ABI and ownership

ABI4 exposes fixed-width little-endian track, packet and event records. Host
`OwnedDemuxSession` owns exactly one instance, validates record extents and time
bounds, and refreshes JavaScript views after growth. Metadata parsing advances
through bounded work steps and NeedInput ranges. The host returns to real tasks,
uses bounded Blob range reads and keeps credits for retired unabortable reads
until they truly settle. Ordinary contiguous packet payloads go from host source
ranges to native EncodedVideoChunk without a WASM payload detour. MPEG-TS uses
explicitly prepared reconstructed-packet scratch, admitted before external ready.
A parser error, OOM, cancellation, trap or post-bootstrap failure is terminal.

Indexes preserve decode order and original signed timebases; trim starts from an
actually bitstream-verified key and retains required preroll/B-frame references.
Packet presentation times need not increase in decode order. Metadata duration
uses the final indexed presentation end, not an untrusted MP4 mdhd duration.
Native decoding/configuration capabilities remain browser-dependent.

Large classic MP4 tracks retain checked STSZ, STCO/CO64, STSC, STTS, CTTS and
STSS tables with sparse byte prefixes and run starts. Packet descriptors are
computed from those records in decode order. CTTS tracks retain a presentation
index proportional to the number of CTTS runs: sorted run starts and prefix
maximum endpoints. Construction and packet-successor queries advance under
explicit work credits, including when many runs overlap. Tracks without CTTS
need no presentation index. No per-sample successor array or sort heap is
allocated. The seek candidate heap is reserved before Ready.
When a nonempty classic sample table is selected, its descriptors remain
authoritative even if `mvex` is present; later `moof` boxes are skipped before
body allocation. Empty classic tables continue through the fragmented route.

`demux_index_info()` returns a 64-byte tag-9 event: mode at byte 4 (0 expanded,
1 compact classic), logical packet count at 8, maximum compressed packet bytes
at 12, actual retained index/input/description capacity at 16, additional
post-Ready seek workspace at 20 (zero because the native heap is preallocated
inside already counted WASM capacity), and flags at
24 (bit 0 means reconstructed payloads; bit 1 means resumable CTTS packet
lookup). `demux_packet_count()` returns the logical count. Without CTTS,
`demux_packet(index)` returns the checked tag-5 descriptor synchronously.
With CTTS, the host calls `demux_query_packet_begin(index)`, advances
`demux_query_packet_step(credit)` until tag 5, then calls
`demux_query_packet_end()`. A working or error step returns tag 11 with state
1 or 4 at byte 4 and error code at byte 8. Each step visits at most 64
overlapping runs, even for a larger requested credit. The last successful
descriptor remains readable through `demux_packet(index)` for host lease
revalidation after the query ends; a different index requires a new query.
The host checks the index record and does not allocate a per-packet JavaScript
descriptor list in compact mode.

Compact seek uses `demux_seek_begin(targetLo, targetHi, beforeIndex)` with signed
timebase ticks and an exclusive decode-index bound (`0xffffffff` means none).
It returns one when a new lease is accepted. `demux_seek_step(credit)` returns a
tag-10 event: state at byte 4 (1 work remains, 2 candidate index, 3 exhausted,
4 error) and candidate index or error code at byte 8. The iterator orders key
container hints by descending presentation time then decode index; the host
must still verify compressed bitstream keys. The next step advances to the next
candidate without rebuilding after a false hint. Packet descriptors remain
readable during the seek lease. `demux_seek_end()` returns one when it clears an
active lease. Compact index snapshot export returns zero as a prospective cache
miss; expanded and imported snapshots retain their existing wire format.

Snapshot exports are bounded logical records, never raw Rust heap dumps. A
versioned header, track/configuration, packet descriptors and optional TS source
records end in CRC32. At most8MiB is exported/imported, in <=8KiB transfers and
<=256 decoded records per bounded import step. Export begin0 means only a
prospective oversize cache miss; high-bit status records retain distinct parser
error codes. Malformed imports are terminal and cannot trigger a retry parse.
Session/generation leases prohibit snapshot work during reads/seeks or another
snapshot operation. A complete import releases its wire buffer and prepares TS
scratch before the host publishes ready.

The main host retains one immutable selected-Blob snapshot and transfers an
independent per-job copy to fresh conversion-owned WASM. Exact Blob identity and
selection generation are authoritative; a bounded SHA256 of length/head/tail is
only supplementary binding, not a complete source hash. Selection replacement,
analysis cancellation, failed validation and reset reject stale publication.
The idle selected state retains no parser instance or codec scratch peak.

## Bounds and qualification limits

Preserve500MiB input,64KiB header reads,16MiB packet/read-credit,
32MiB live metadata/index,64MiB linear capacity and128MiB demux policy envelopes.
Resource admission includes growth overlap, main snapshot master, job copy,
import source, index/scratch, outstanding/retired reads and native queued-chunk
allowances. Slots within linear memory are counted once. The caller's existing
full ArrayBuffer backing is reported separately; there is no claim that source
accounting measures total browser, native decoder or GPU process peak.

The compiled differential suite covers configurations, sampled metadata rates,
packet payload/order/timestamps, verified seeks and snapshot round trips. Rust
native tests, strict Clippy, pinned regeneration, static alias/bounds review and
actual browser/product checks have distinct evidence. JavaScript/Actions CodeQL
does not establish Rust-source semantic coverage. Final acceptance, dependency
classification, protected integration and deployment status remain in #494.
