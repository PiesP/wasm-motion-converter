# Maintained dependency patches

## MediaBunny memory limits

`mediabunny@1.62.0.patch` applies to the exact published 1.62.0 package. The
application sets finite limits in `src/utils/mediabunny-utils.ts`; the patch
enforces them in the imported ESM modules and mirrors the changes in the shipped
TypeScript source. It bounds contiguous reads, encoded packets, retained parser
buffers, nested HLS inputs, and packet-sink prefetch. MP4 parsing also enforces
cumulative metadata and logical-sample budgets before expanding tables or
fragments. FLAC, Ogg, Matroska, and MPEG-TS apply the same input budgets to their
retained data. The reader declaration matches its patched constructor.

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

The 1.62.0 port preserves upstream sample-table clamping and lazy Matroska block
decoding while retaining the same metadata, packet, and memory limits. The
installed-parser tests in
`test/unit/utils/mediabunny-memory-limits.test.ts` and
`test/unit/utils/mediabunny-mp4-metadata-limits.test.ts` exercise bounded
rejection and valid media with the actual patched package.
`test/unit/utils/mediabunny-matroska-metadata.test.ts` covers the Matroska skip
policy and the dependency's unchanged default metadata behavior.

For a later MediaBunny update, review the complete published package delta and
port the patch to its runtime modules, source, and declarations. Update the exact
`package.json` version, `pnpm-workspace.yaml` selector, patch filename, and
`pnpm-lock.yaml` together. Run a clean frozen install and the installed-parser
tests before the full verification gate. pnpm's unused-patch error is a guard
against shipping an unreviewed package. To roll back this update, restore those
four files together from the previous revision and use a frozen install.

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
