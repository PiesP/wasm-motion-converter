# Owned demux differential fixtures

Synthetic inputs generated from owned FFmpeg color/testsrc2 sources. No owner
media is included. `oracle.json` freezes patched MediaBunny1.65.2 metadata and
decode-order packet identities, verified-key seeks and independent FFmpeg
decoded-frame hashes. Its source/patch/toolchain/input digests retain provenance.
The owned fixture generator and maintained E2E generator own reproducible input
commands; existing no-index/no-cues fixtures retain their original test source.

Run focused actual compiled-WASM checks through the maintained Vitest unit
project. A partial match does not establish product adoption or remove the
production dependency. Additional malformed/codec-variant inputs must be frozen
before their candidate comparisons; do not rewrite previous failed receipts.
