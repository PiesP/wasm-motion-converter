# Maintained dependency patches

## MediaBunny memory limits

`mediabunny@1.66.2.patch` applies to the exact published 1.66.2 package. The
development-only oracle sets finite limits in `test/helpers/mediabunny-oracle.ts`.
The patch enforces them in the oracle's imported ESM modules and includes
changes for the shipped TypeScript source. Production metadata and demux use the
owned Rust/WASM core; MediaBunny and this patch remain development references.
The patch bounds contiguous reads, encoded packets, retained parser
buffers, nested HLS inputs, and packet-sink prefetch. MP4 parsing also enforces
cumulative metadata and logical-sample budgets before expanding tables or
fragments. FLAC, Ogg, Matroska, and MPEG-TS apply the same input budgets to their
retained data. The Reader and Matroska declarations match their patched source.

The development oracle does not use Matroska tags or attachments. Its inputs opt into skipping these
descriptive elements before reading their payloads, including leading metadata
and tags reached through seek entries in later segments. The shared element
traversal also skips descriptive IDs before decoding or retaining them, even in
malformed nested contexts or while parsing a cluster without a current segment.
Structural track, codec, timing, and cue elements remain parsed. Inputs without
the opt-in retain MediaBunny's original metadata behavior. The installed-parser
test sets its 256-byte Reader limit before format detection and checks reads at
and beyond that boundary; changing the Input field afterward would not update
the Reader.

The 1.66.2 port preserves upstream iterative fragment/cluster lookup and skips
position-cache entries without a key frame during key-packet searches. It also
retains the 1.63.0 reference-PES header fix. The 1.66.2 MPEG-TS reader consumes
PES payloads incrementally from transport packets, so the old full first-section
reread is obsolete. Its scratch growth, copied packets, and reordered packet
buffers remain subject to the local byte budgets. The local MP4 sample and
metadata budgets, both encryption auxiliary-info reservations, Matroska
descriptive skip and final packet/side-data check, nested HLS budgets, and
finite-budget packet-sink on-demand mode also remain in the imported ESM
modules. The patch includes TypeScript source and declarations. MP4
fragment-position cache entries retain
their 96-byte metadata reservation. Matroska cluster-position cache entries and
cluster summaries now share a finite lookup-cache allowance based on the input's
buffered-packet budget; conservative estimates reserve 96 bytes per position,
128 bytes per summary, and 64 bytes per summarized track before insertion.
The installed-parser tests in
`test/unit/utils/mediabunny-memory-limits.test.ts` and
`test/unit/utils/mediabunny-mp4-metadata-limits.test.ts` exercise bounded
rejection and valid media with the actual patched package.
`test/unit/utils/mediabunny-matroska-metadata.test.ts` covers the Matroska skip
policy and the dependency's unchanged default metadata behavior.
`test/unit/utils/mediabunny-packet-lookup.test.ts` covers cold and warm key-packet
lookup in cue-less WebM clusters and no-index MP4 fragments, plus a finite
Matroska lookup-cache rejection.

The port was checked against the published [1.66.2 npm tarball](https://registry.npmjs.org/mediabunny/-/mediabunny-1.66.2.tgz)
(`sha512-NTzRrBhAyRVi8qpJ9AH6XPyxiDVkfugxYY+gu3Z5zi+Nw2R/7nTAnXJEt2Ucy8wTIve1/UYGnCFf50x2LpvMDQ==`,
SHA-256 `0a1a1011496a7527175bb7ada56ecc4371244f6a00f082d77fd3e668230eb01e`),
the [1.65.2...1.66.2 source delta](https://github.com/Vanilagy/mediabunny/compare/v1.65.2...v1.66.2),
and [1.66.2 release notes](https://github.com/Vanilagy/mediabunny/releases/tag/v1.66.2).
The 1.65.1 retention decision in issue #453 remains historical evidence for
that version. Later key-packet lookup changes apply to the comparator's seek
results.
The 1.63.0 reference-PES change is upstream; the local limits above are still
required. The two MP4 auxiliary-info call sites retain their reservation
callback, and the Matroska final packet check follows codec-delay handling.
The 1.66.2 asynchronous MP4 fragment reader reserves its summary and position
cache before insertion and releases its transient budget on both success and
failure. The patched TypeScript source includes a second accounting reset after
auxiliary-data handling. The comparator executes the ESM files, where the reset
runs after synchronous fragment parsing. Rebuilding from the patched TypeScript
source and encrypted-fragment parity are outside this comparison.

The historical `test/fixtures/owned-demux/oracle.json` records the
1.65.2 comparator and the digest of `mediabunny@1.65.2.patch`.
The 1.66.2 comparison of the same 41 inputs found 17 packet durations rounded
from 166666 to 167000 microseconds in seven Matroska/WebM fixtures. Their
average packet rates and bitrates reflect the new final packet end times.
The `hevc-hvc1.mp4` decoder configuration now uses the container's `hvc1`
prefix for its codec string. Packet timestamps, types, sizes, data hashes,
verified-key seeks, and same-tool FFmpeg decoded-frame hashes matched.

For a new capture, run `scripts/test/freeze-demux-oracle.ts` with Git, FFmpeg,
and the repository's frozen pnpm installation. It checks the imported version,
selected patch bytes, and installed lock before reading inputs. New captures
record the lockfile SHA-256 alongside the version and patch SHA-256. To
reproduce a historical capture, use its recorded source revision and tools.

For a later MediaBunny update, review the complete published package delta and
port the patch to its runtime modules, source, and declarations. Update the exact
`package.json` version, `pnpm-workspace.yaml` selector, patch filename,
`pnpm-lock.yaml`, and generated `public/LICENSES.md` together. Run a clean
frozen install and the installed-parser tests before the full verification gate.
pnpm's unused-patch error is a guard
against shipping an unreviewed package. To roll back this update, restore those
five artifacts and this patch mapping together from the previous revision, then
use a frozen install.

## wasm-webp strict-CSP patch

`wasm-webp@0.1.0.patch` changes the ESM glue used by the development-only VP8 comparison encoder. Its
Emscripten bindings otherwise construct JavaScript functions from strings during
initialization, which the application's CSP rejects. The WebAssembly binary and
package version are unchanged.

The patch uses closures for bound calls and JavaScript method calls, with separate
argument storage for each invocation and the existing wire-type/destructor
contracts. Global lookup uses `globalThis`. Neither the application nor its
deployment headers permit JavaScript `unsafe-eval`.

This follows the static binding approach described by Emscripten's
[`DYNAMIC_EXECUTION=0` guidance](https://emscripten.org/docs/tools_reference/settings_reference.html#dynamic-execution).
The patch applies only to the imported ESM build; the unused CommonJS build is
unchanged. Remove it when an upstream release supplies compatible static glue,
after the same checks pass.

`test/unit/config/csp-policy.test.ts` initializes the real WASM module under
Node's `--disallow-code-generation-from-strings`, round-trips distinct RGB frames,
and checks repeated use and argument validation. The browser output-contract
suite forces the owned VP8 fallback under the application's actual CSP and decodes
the resulting animation to verify geometry, color order, and timing. pnpm binds
the exact patch hash in the lockfile and rejects an unapplied patch.

### Historical initialization behavior

The archived 7d9e0f1b application retained a rejected wasm-webp initialization
for the document lifetime and offered an explicit reload under its busy-work
and result protections. The pinned Emscripten factory keeps per-invocation
memory, binding registries and a dependency watcher. A failed streaming fetch
can reject `Module.ready` while that watcher still retains the partially
initialized instance. The factory provides no partial-runtime disposal API.

The current application loads the owned VP8 module. After an initialization
failure the user can retry in the same document. Installed-browser validation
checks failed fetch, invalid module, cancellation, physical settlement and
recovery. Older wasm-webp observations remain bound to the archived builds.
