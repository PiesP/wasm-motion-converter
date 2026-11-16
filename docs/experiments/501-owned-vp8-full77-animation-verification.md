# #501 V8 input-capture animation verification

`scripts/test/owned-vp8-animations.ts` accepts the exact
`owned-vp8-product-v8-low-inputs.json` report from the instrumented Windows
main-software route. Supply the complete controller run, expected candidate
source SHA and a new private output directory with `--run`, `--expected-source`,
`--output` and `--report`. The existing controller result, transport, collection,
bundle, source, input and distribution checks still apply.

The verifier requires the frozen 1920 × 1080 V8 source, low/q60/12 fps settings,
both prior and candidate captures, 77 complete streamed input rows per build,
the five retained RGB copies, and exact pairwise input hashes and presentation
metadata. It checks each JSONL and RGB file against the collected file digest
and the report. Each RGB filename must match its build and frozen ordinal, so
one retained file cannot be counted as a different control. The captured input
`frameNum` is an internal decoder counter;
it is not an original video frame index.

For each saved WebP, the verifier checks the collected bytes, RIFF and VP8
structure, 77 opaque full-canvas frames, 6400 ms duration, infinite loop,
reported frame order, ICC, and independent FFmpeg native VP8 and libvpx RGBA
decode agreement. It reports per-frame and whole-output byte comparisons,
without treating them as a new size gate. The decoded frames are hashed one at a
time; the verifier does not retain all raw RGBA frames in memory.

With 77 inputs and 77 emitted frames, each output frame must start at the
rounded absolute `startUs` of its corresponding observed input. Its hold must
end at the next rounded input start, or at the frozen 6400 ms video endpoint for
the final frame. Every hold must meet the muxer's existing 11 ms floor; otherwise
the muxer would have coalesced an input. This binds output order and timing to
observed callback presentation without asserting that the internal frame counter
is the source video's frame index.

The decoder prefers a native frame's known duration for its terminal interval.
That raw microsecond endpoint may be 6,400,333 us, which the muxer rounds to
6,400 ms. Every input interval must end within the rounded 6,400 ms window, and
the terminal endpoint must equal 6,400 ms after rounding. The verifier checks
the exact ANMF timeline separately; it does not impose a raw 6,400,000 us cap. The first verifier
attempt incorrectly imposed that cap and failed before decoding; its receipt
remains preserved. This correction changes no output timing or quality gate.

This is structural and encoder-input evidence. Original-video frame selection
and PTS mapping, independent source-reference PSNR/SSIM, actual temporal visual
review, product timing, physical memory and platform acceptance remain separate.
Do not infer selected source indices from a nominal 30-to-12 fps ratio. A
perceptual or adoption decision requires a prospectively source-bound reference
and the existing #501 acceptance contract; this verifier makes no such decision.
