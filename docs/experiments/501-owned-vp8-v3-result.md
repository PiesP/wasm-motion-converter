# Owned VP8 corrected-v3 candidate result

Canonical execution ledger: [issue501](https://github.com/PiesP/wasm-motion-converter/issues/501).
Outcome: **REJECTED / PARTIAL engineering progress; no runtime removal**.

The prospectively frozen candidate is clean source
`c880a6dab6fc38311109968295ac56fa5ca3fecc`, owned WASM SHA256
`9c5247dc251aaabf79807c930c6300379d7c9e662ddcca08e363f5a9e578167f`
(177405 raw / 36574 independently gzip-9-mtime-0 bytes). The primary comparator
remains the shipped patched wasm-webp@0.1.0 binary
`4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22`.
The v3 manifest is `072947742fe4fce1aaf77702f8cfee3d2c7410a79d5715155f047913f00c2d2a`.
Node26.13.1, Rust1.99.1 and FFmpeg7.1.5 were used. Exact fixture, tool,
candidate/harness and output identities remain in the external receipts.

All 45 tuning conditions and both 45-condition exposed regression cohorts passed.
Fresh corrected-v3 passed **43/45**. All 45 PSNR and SSIM gates passed, but two
size gates failed on the 4160x2419 admitted large fixture:

| Preset | Baseline bytes | Candidate bytes | Maximum bytes | Baseline/candidate PSNR | Baseline/candidate SSIM |
| --- | ---: | ---: | ---: | --- | --- |
| low/q60 | 66660 | 92420 | 83325 | 37.674335 / 37.846050 | 0.964789 / 0.967530 |
| high/q85 | 106326 | 138466 | 132907.5 | 38.594865 / 38.681015 | 0.972652 / 0.973478 |

No threshold, geometry, cadence or selected-frame setting changed. Large-condition
linear capacities were 104464384 and 104660992 bytes, below the existing 192MiB
module ceiling. Input copies were 40252160 bytes per condition. Capacity accounting
and Node step durations do not establish browser/GPU peak memory or product speed.

The first invocation supplied `--photo` rather than the existing `--fresh-photo`
argument and stopped at the photo fixture. Its failed log and 33 completed
conditions are retained. Completion used the correct argument with the exact same
source, WASM, harness, fixture manifest, pixels and gates. All 33 overlapping
input/output digests, byte sizes, quality metrics and gate results match. This is
completion of one frozen evaluation, not an independent second fresh cohort.

External evidence under the task's private artifact root:
`m2-neutral-19`, `m2-neutral-v1-regression-08`, `m2-neutral-v2-regression-08`,
`m2-corrected-v3-acceptance-01`, `m2-corrected-v3-acceptance-01-complete`,
`m2-v3-completion-overlap.json`, and `m2-neutral-19-{full-rust,fmt,clippy,compiled,artifact-check}.log`.
Rust82/82 including independent native VP8/libvpx decoder cases, fmt, Clippy,
compiled ABI2 engineering tests and offline byte-identical artifact rebuild pass.
They do not override the rejected size gates or qualify the product route.

Corrected-v3 is now exposed regression evidence. Previous candidate failures and
their frozen criteria remain unchanged. Next: diagnose generic segment/residual/
signaling efficiency, implement a bounded hypothesis and recheck exposed controls.
A corrected candidate requires a new prospective, controlled fresh evaluation.
Windows animation/lifecycle, balanced whole-product performance, final resource,
current-browser and delivery gates remain open. Production retains wasm-webp.
