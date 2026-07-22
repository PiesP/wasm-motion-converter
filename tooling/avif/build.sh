#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)

: "${EMSDK_DIR:?Set EMSDK_DIR to the Emscripten SDK checkout}"
libavif_dir=${LIBAVIF_DIR:-"$repo_root/.cache/libavif-v1.4.2"}
libavif_ref=${LIBAVIF_REF:-v1.4.2}
aom_ref=${AOM_REF:-v3.14.1}
build_root=${AVIF_BUILD_ROOT:-"$repo_root/.cache/avif-build"}
output_dir=${AVIF_OUTPUT_DIR:-"$repo_root/public/wasm"}

if [[ "$output_dir" != /* ]]; then
    output_dir="$repo_root/$output_dir"
fi

source "$EMSDK_DIR/emsdk_env.sh"

expected_emscripten_version=${EMSCRIPTEN_VERSION:-6.0.3}
actual_emscripten_version=$(emcc --version | awk '/^emcc /{print $(NF - 1); exit}')
if [ "$actual_emscripten_version" != "$expected_emscripten_version" ]; then
    echo "Expected Emscripten $expected_emscripten_version, found $actual_emscripten_version" >&2
    exit 1
fi

if [ ! -d "$libavif_dir/.git" ]; then
    mkdir -p "$(dirname "$libavif_dir")"
    git clone --depth 1 --branch "$libavif_ref" https://github.com/AOMediaCodec/libavif.git "$libavif_dir"
fi

actual_libavif_ref=$(git -C "$libavif_dir" describe --tags --exact-match 2>/dev/null || true)
if [ "$actual_libavif_ref" != "$libavif_ref" ]; then
    echo "Expected libavif $libavif_ref, found ${actual_libavif_ref:-an untagged checkout}" >&2
    exit 1
fi

if [ ! -d "$libavif_dir/ext/aom/.git" ]; then
    git clone --depth 1 --branch "$aom_ref" https://aomedia.googlesource.com/aom "$libavif_dir/ext/aom"
fi

actual_aom_ref=$(git -C "$libavif_dir/ext/aom" describe --tags --exact-match 2>/dev/null || true)
if [ "$actual_aom_ref" != "$aom_ref" ]; then
    echo "Expected libaom $aom_ref, found ${actual_aom_ref:-an untagged checkout}" >&2
    exit 1
fi

mkdir -p "$output_dir"

emcmake cmake -S "$script_dir" -B "$build_root" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_RUNTIME_OUTPUT_DIRECTORY="$output_dir" \
    -DLIBAVIF_SOURCE_DIR="$libavif_dir"

cmake --build "$build_root" --target avif_encoder --parallel "${AVIF_BUILD_JOBS:-2}"

# These are browser assets, not executable programs. CMake may preserve the
# executable bit from the generated target, so normalize the checked-in mode.
chmod 644 "$output_dir/avif-encoder.js" "$output_dir/avif-encoder.wasm"

echo "AVIF WASM artifacts written to $output_dir"
