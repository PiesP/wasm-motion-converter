# Maintained dependency patches

## MediaBunny memory limits

`mediabunny@1.65.2.patch` applies to the exact published 1.65.2 package. The
application sets finite limits in `src/utils/mediabunny-utils.ts`; the patch
enforces them in the imported ESM modules and mirrors the changes in the shipped
TypeScript source. It bounds contiguous reads, encoded packets, retained parser
buffers, nested HLS inputs, and packet-sink prefetch. MP4 parsing also enforces
cumulative metadata and logical-sample budgets before expanding tables or
fragments. FLAC, Ogg, Matroska, and MPEG-TS apply the same input budgets to their
retained data. The Reader and Matroska declarations match their patched source.

WMC does not use Matroska tags or attachments. Its inputs opt into skipping these
descriptive elements before reading their payloads, including leading metadata
and tags reached through seek entries in later segments. The shared element
traversal also skips descriptive IDs before decoding or retaining them, even in
malformed nested contexts or while parsing a cluster without a current segment.
Structural track, codec, timing, and cue elements remain parsed. Inputs without
the opt-in retain MediaBunny's original metadata behavior. The installed-parser
test sets its 256-byte Reader limit before format detection and checks reads at
and beyond that boundary; changing the Input field afterward would not update
the Reader.

The 1.65.2 port preserves upstream iterative fragment/cluster lookup and skips
position-cache entries without a key frame during key-packet searches. It also
retains the 1.63.0 reference-PES header fix. That upstream fix does not bound MPEG-TS
section, PES, or reordered packet buffers, so the local first-section reread and
byte budgets remain. The local MP4 sample and metadata budgets, both encryption
auxiliary-info reservations, Matroska descriptive skip and final packet/side-data
check, nested HLS budgets, and finite-budget packet-sink on-demand mode also
remain. The port mirrors these limits in the imported ESM modules and shipped
TypeScript and matching declarations. MP4 fragment-position cache entries retain
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

The port was checked against the published [1.65.2 npm tarball](https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz)
(`sha512-goZpibvo/5hkc/56WVNm93Ini+o7K4y8aXA20c/BN1B+m3L5aHQa8MTvO+S1APg/YI8kMILtrX6QCqUtxLW7bA==`,
SHA-256 `93bceb27fd807e06e8b6a0e9e02350bf69e1d70da12d685dd0b133b54c3b1ff6`),
the [1.65.0...1.65.2 source delta](https://github.com/Vanilagy/mediabunny/compare/v1.65.0...v1.65.2),
and [1.65.2 release notes](https://github.com/Vanilagy/mediabunny/releases/tag/v1.65.2).
The 1.65.1 retention decision in issue #453 remains historical evidence for
that version; the later key-packet lookup changes reach WMC's nonzero-trim path.
The 1.63.0 reference-PES change is upstream; the local limits above are still
required. The two MP4 auxiliary-info call sites retain their reservation
callback, the Matroska final packet check follows codec-delay handling,
and the MPEG-TS first-section reread follows the moved packet lookup method.
The 1.65.2 MP4 output-flag change is outside WMC's demux-only MediaBunny use.
The AES stream error close can affect encrypted HLS input, but does not change
WMC's locally imposed nested-reader and packet budgets.

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

`wasm-webp@0.1.0.patch` changes the ESM glue used by the application. Its
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
suite forces the WASM fallback under the application's actual CSP and decodes
the resulting animation to verify geometry, color order, and timing. pnpm binds
the exact patch hash in the lockfile and rejects an unapplied patch.

### Failed initialization

The application retains a rejected WebP initialization for the document lifetime
and offers an explicit reload under the existing busy-work/result protection.
The locked Emscripten factory owns per-invocation memory, binding registries and a
10-second dependency watcher. A rejected streaming fetch rejects `Module.ready`
without calling `abort` or removing the `wasm-instantiate` dependency; the watcher
can therefore retain a partially initialized runtime. There is no supported
partial-runtime disposal API. Reinvoking this factory may succeed but does not
release that earlier runtime, so clearing only the application Promise is not a
qualified recovery. No allocation exhaustion is induced to test this boundary.

`WasmWebpInitializationError` separates factory failures from import/evaluation
failures and retains the original cause. Both require explicit reload; a
browser's failed module graph is not repaired by resetting an application
Promise. Successful initialization remains shared, frame errors do not reset it,
and caller cancellation does not dispose it. No conversion or reload is retried
automatically. The focused built output-contract/Windows scenario injects one
failed factory fetch, a separate module-evaluation failure, and a cancelled late
factory failure, then exercises the real reload action and decodes a valid WebP.
These controlled failures do not establish a reported incident or its frequency.
