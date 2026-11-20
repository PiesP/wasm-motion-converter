# #501 exposed V8 original-reference diagnostic

`scripts/test/owned-vp8-v8-quality.ts` is a two-stage, private reader for the
frozen 77-frame Windows V8 capture. It does not encode, change the application,
or make an adoption decision. The source-map stage is the default and uses only
the original WebM, the passing product report, the independent animation
verification report, and FFprobe. Freeze its `source-map.json` SHA-256 before
running the explicit `diagnostic-exposed-v8` stage. Keep both new output
directories outside the repository, distribution, and public assets.

The frozen input is `validation/windows/owned-vp8-inputs/v8.webm`, SHA-256
`c6a21a3a7619ca7fbcbc1b4d012d7098d18f599f0200f735d31cae15a4772dd1`,
3,145,371 bytes, 1920 × 1080, 192 decoded VP9 frames over 6400 ms. The product
report SHA-256 is
`9dfd23ca45b6f8540c78eef9444c006a74bbe4e6b8a48ddf3c3ef8ac331a2fa3`;
the independent all-77 animation verification SHA-256 is
`f54471e8f92e4baf2e7314e118a7827aeb76ca782fb9a2c050a94756181ccf60`.
The observed encoder-input RGB hashes and presentation starts are equal across
the prior `be35f5fa…` and candidate `ffa113f5…` captures. The five retained
actual RGB inputs have output ordinals 0, 19, 38, 57 and 76.

## Frozen mapping

FFprobe must identify one VP9, yuv420p, BT.709 video stream with time base
`1/1000`, 192 decoded frames, and integer frame PTS. The reader converts every
PTS with a BigInt rational to integral microseconds, then finds each of the 77
observed `startUs` values exactly once in increasing decoded-frame order.
There is no cadence-based frame selection. The independent source-only
preparation (`v8-source-pts-preparation-01/source-pts-stdout.json`, SHA-256
`ff35379f0052cfdd3ac222e0c6521603579600b0c8425d75f7e05e7fa4264d84`)
found that 13 ordinals differ from a nominal `ceil(2.5k)` model: ordinal 4 maps
to source frame 11, and the last maps to frame 191. The observed `frameNum`
happens to match the source index for this fixture; it is still a decoder
counter, so the reader does not use it as a source index.

Example invocation with a fresh, nonexistent output path under the same private
`wmc-501-vp8-v2` artifact root as the frozen run:

```sh
node --experimental-strip-types scripts/test/owned-vp8-v8-quality.ts \
  --run /absolute/path/to/wmc-501-vp8-v2/runtime-combined-preparation-01/windows-all77-ffa113-01 \
  --verification /absolute/path/to/wmc-501-vp8-v2/runtime-combined-preparation-01/all77-animation-verification-02/verification.json \
  --output /absolute/path/to/wmc-501-vp8-v2/new-source-map-directory \
  --ffprobe /absolute/path/to/pinned/ffprobe
```

The reader requires FFprobe SHA-256
`cefc5f81c0b18429cdbf8fa5a89e1e9c759235e10f93f9b329ff1b2fdff26f46`.
The command writes `source-map.json` exclusively in the new directory. Its
scope is `SOURCE_TIMESTAMP_ALIGNMENT_ONLY`; source-reference pixel quality
remains unmeasured until the second stage. The directory is created exclusively
before preflight or FFprobe starts; an existing directory is left untouched.
`ffprobe-source.request.json`, raw bounded stdout and stderr,
and `ffprobe-source.status.json` retain its exact command, 30-second deadline,
PID, actual exit code or signal, and timeout state. A failed probe also leaves
`failure.json`; no failed source map is accepted as a frozen map.

## Bounded scoring

After a coordinator freezes the map digest and exact execution plan, the
explicit diagnostic stage uses FFmpeg SHA-256
`e8a8d46f5225f3062cec7c07fb145d58ae73c603cb740dcd5bad34bfb54e455a`:

```sh
node --experimental-strip-types scripts/test/owned-vp8-v8-quality.ts \
  --purpose diagnostic-exposed-v8 \
  --run /absolute/path/to/wmc-501-vp8-v2/runtime-combined-preparation-01/windows-all77-ffa113-01 \
  --verification /absolute/path/to/wmc-501-vp8-v2/runtime-combined-preparation-01/all77-animation-verification-02/verification.json \
  --source-map /absolute/path/to/wmc-501-vp8-v2/frozen-source-map-directory/source-map.json \
  --source-map-sha256 FROZEN_64_HEX_DIGEST \
  --output /absolute/path/to/wmc-501-vp8-v2/new-diagnostic-directory \
  --ffmpeg /absolute/path/to/pinned/ffmpeg
```

The reader decodes the full original stream in order with explicit
`-noautorotate` for this fixed zero-rotation source and no fps, scale,
resample, or drop filter, and retains only its 77 mapped RGB frames. It decodes
both independently verified IVF streams using native VP8 and checks every
decoded RGBA SHA-256 against that verifier before creating the output RGB
frame. Each frame is opaque 1920 × 1080. The reader awaits each write before
advancing to the next frame and releases the previous frame backing; this is
logical memory accounting, not a measured physical peak. It writes 77 source
and 154 output RGB24 files: 231
files × 6,220,800 bytes = 1,437,004,800 raw bytes, below the private 2 GiB
artifact cap. An additional 128 MiB allowance covers bounded receipts,
JSONL/report files, and one initialized partial RGBA frame; the planned upper
bound remains below 2 GiB. Source and output frame counts are enforced. This
host-side diagnostic allowance does not alter browser runtime, SDK 128-file collection,
or product 512/128/192/96 MiB limits. Do not put these raw files in a browser
payload, repository, distribution, public assets, or an upload.

The three decoder children run one after another: original 192, prior 77,
candidate 77. Each must close before any later decoder or SSIM child starts.
Their private receipts contain the request, 64 KiB raw stdout prefix, byte
count and SHA-256 of the bytes actually observed by the reader,
`stdoutReachedEof`, 64 KiB stderr prefix, PID, actual code and signal, timeout
state, and completed-frame count. `stdoutReachedEof=false` means a failed
iterator may have observed only a prefix of the child stream; `true` alone does
not establish a successful decode after a timeout or decoder failure. Full raw RGBA stdout is
not retained: its size would exceed the 2 GiB artifact cap. If a stream fails
inside a frame, only initialized bytes of that frame are saved as private
partial RGBA evidence, at most 8,294,400 bytes. The source decode has a
10-minute deadline; each output decode has a 5-minute deadline. Every SSIM
child has a 60-second deadline and retains its complete raw stdout/stderr
within 8192-byte caps. These are execution limits, not observed timeout results.

For each of the 77 mapped frames, the reader reports separate prior and
candidate RGB PSNR against the original frame and FFmpeg RGB SSIM (`gbrp`,
same geometry, one frame, `stats_file=-`). PSNR is calculated over all RGB
samples; exact equality is explicit. It retains every row, the minimum delta,
and failing ordinals under the unchanged candidate-minus-prior floors of
-1 dB and -0.01. It also compares total saved WebP bytes with
`max(1.25 × prior bytes, prior bytes + 128)` as a diagnostic.

The five actual RGB controls are scored separately against their own retained
post-WASM encoder-input files after checking their frozen per-file hashes.
Those rows have the same PSNR and SSIM floors plus a per-frame raw VP8 byte
limit of `max(1.25 × prior bytes, prior bytes + 128)`. These controls and the
77 original-reference rows answer different questions. A third, unthresholded
`sourceToCanvas` table directly measures each of the five captured encoder-input
RGB files against its mapped original RGB frame, separately for prior and
candidate. It does not derive this residual by subtracting two PSNR values.
RGB residuals across source decoding, browser processing, and encoding are not
additive, and a passing average cannot cancel a failing row or class.

The output `diagnostic.json` identifies the source map, product report,
verifier, decoder commands, every row, all minima and failures, the five direct
color controls and five codec residual controls, and the private byte budget.
Completed rows are also appended to three exclusive JSONL files after each
row settles. A later failure retains those rows, all completed raw RGB files,
child receipts and `failure.json`; that failure summary lists only JSONL files
actually present, with their byte hashes, valid complete-JSON row counts,
terminated-line counts and trailing-byte counts. Source-map failures use a
separate status. No failure receipt is
written into a pre-existing output directory. A failed attempt does not produce
a passing summary.
This exposed capture is diagnostic only.
Its FFmpeg original-reference colors are a specified decoder interpretation of
the WebM, not a claim of exact browser Canvas RGB identity. Actual temporal
visual review, product timing, physical memory, other modes and platforms,
fresh held-out acceptance, and an adoption decision remain separate work.

## Executed exposed diagnostic, 2026-11-16

The reader at signed commit `11f36894d836b1b225c9eb026c75a8d6bedc02b1`
completed the source-map and explicit diagnostic stages with actual exit code 0.
The product capture remains `ffa113f5`; the independent decoder reader remains
`4ca407d8`. The measured owned module is `bd170496`. The exclusive prospective
plan SHA-256 was `3fca4d916a6018e552917f4babcdacdf3a827cf4ef019a5eda0205fe0938d254`.

- Source-map SHA-256: `547f244271e6060ebf5c9656f50eb70bca315f4eef2bb28cb5f2cf29ec03d6ae`.
- Diagnostic SHA-256: `ffda451a99ac5f9f2fbf1cea198d300fb8c5eeb9f262fa5bd6bfc2d0a1967a5e`.
- All 192 original and both 77 output frames decoded serially, and every output
  RGBA digest matched the independent native VP8/libvpx verification.
- Original-reference PSNR failed ordinals 70, 75 and 76: candidate deltas were
  -1.304898, -1.612122 and -1.704513 dB under the unchanged -1 dB floor. All 77
  SSIM comparisons passed, with a minimum delta of -0.002037.
- The five actual-input RGB residual controls passed PSNR, SSIM and raw frame
  size. Their worst PSNR delta was -0.628164 dB and minimum SSIM delta +0.000032.
  The direct original-to-Canvas measurements match across the two backends.
- Saved total bytes were 1,983,774 prior and 2,307,098 candidate, within the
  unchanged 2,479,717.5-byte allowance. Actual retained private files occupied
  1,437,560,865 bytes, below the 2 GiB cap. Streamed decoder byte counts are not
  physical memory or delivery measurements.

The original-reference diagnostic is **rejected**. Separate reference outcomes
do not cancel failed rows. Preserve the report and all original receipts; a
corrected encoder requires a new source-bound candidate and prospective
comparison. No V13 candidate encode, other-preset acceptance, temporal visual
review, performance/resource acceptance or runtime removal follows from this
result. Investigate signed color/residual error and actual preset branches
before selecting a bounded correction; do not change the source reference or
thresholds to erase the failure.
