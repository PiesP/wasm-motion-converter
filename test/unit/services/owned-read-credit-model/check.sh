#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 PiesP
set -euo pipefail

model_dir=$(cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -r -- "$scratch"' EXIT

jar=${TLA2TOOLS_JAR:-"$scratch/tla2tools.jar"}
if [[ -z ${TLA2TOOLS_JAR:-} ]]; then
  curl --fail --location --silent --show-error --max-time 60 \
    https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
    --output "$jar"
fi
expected=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
actual=$(sha256sum < "$jar")
if [[ ${actual%% *} != "$expected" ]]; then
  printf 'TLC v1.7.4 JAR checksum mismatch\n' >&2
  exit 1
fi
jar=$(realpath -- "$jar")

cp -- "$model_dir/OwnedReadCredit.tla" "$model_dir/OwnedReadCredit.cfg" "$scratch"
cd -- "$scratch"

run_tlc() {
  java -XX:+UseParallelGC -Xmx512m -cp "$jar" tlc2.TLC \
    -workers 1 -fp 0 -coverage 1 -metadir "$1" OwnedReadCredit.tla
}

run_tlc model

printf '\nEarly-return control (expect CreditConservation violation)\n'
sed -i 's/EarlyReturn = FALSE/EarlyReturn = TRUE/' OwnedReadCredit.cfg
status=0
run_tlc control > control.log 2>&1 || status=$?
cat control.log
# TLC 2.19 exits 12 for an invariant violation.
if [[ $status -ne 12 ]] || ! grep -Fq 'Invariant CreditConservation is violated' control.log; then
  printf 'Early-return control did not produce the expected counterexample\n' >&2
  exit 1
fi
