# Animated AVIF WASM build

This directory builds the browser AVIF encoder used by `src/services/avif-encoder-service.ts`.

The build is intentionally pinned to:

- libavif `v1.4.2`
- libaom `v3.14.1`
- Emscripten `6.0.3`

The generated module targets `web,worker` and exposes a stateful
`AvifAnimationEncoder` binding. It must not be replaced with a single-frame
`@jsquash/avif` call: animated AVIF requires one ordered libavif encoder
session with per-frame durations.

## Build

Install and activate Emscripten, then run:

```sh
EMSDK_DIR=/path/to/emsdk pnpm build:avif
```

Optional variables:

- `EMSCRIPTEN_VERSION`: override the checked Emscripten version only when regenerating both artifacts together (default: `6.0.3`)
- `LIBAVIF_DIR`: checkout location (default: `.cache/libavif-v1.4.2`)
- `AVIF_BUILD_ROOT`: CMake build directory (default: `.cache/avif-build`)
- `AVIF_OUTPUT_DIR`: output directory (default: `public/wasm`)
- `AVIF_BUILD_JOBS`: parallel build jobs (default: `2`)

The build uses `AOM_TARGET_CPU=generic` so CI and browser builds do not depend
on a host assembler. SIMD/assembler optimization should be benchmarked as a
separate, explicitly supported toolchain variant.

After building, verify the sequence ABI and timing boxes with:

```sh
node tooling/avif/test-sequence.mjs
```
