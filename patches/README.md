# Maintained dependency patches

## MediaBunny memory limits

`mediabunny@1.61.5.patch` applies to the exact published 1.61.5 package. The
application sets finite limits in `src/utils/mediabunny-utils.ts`; the patch
enforces them in the imported ESM modules and mirrors the changes in the shipped
TypeScript source. It bounds contiguous reads, encoded packets, retained parser
buffers, nested HLS inputs, and packet-sink prefetch. MP4 parsing also enforces
cumulative metadata and logical-sample budgets before expanding tables or
fragments. FLAC, Ogg, Matroska, and MPEG-TS apply the same input budgets to their
retained data. The reader declaration matches its patched constructor.

The 1.61.5 port preserves upstream source-disposal, HLS empty-segment, decoder
queue, conversion-progress, and color-space changes. No existing safety hunk was
supplied upstream by this release. The installed-parser tests in
`test/unit/utils/mediabunny-memory-limits.test.ts` and
`test/unit/utils/mediabunny-mp4-metadata-limits.test.ts` exercise bounded
rejection and valid media with the actual patched package.

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
