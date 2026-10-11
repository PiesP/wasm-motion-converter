# Presentation timing

Automatic preset cadence uses an anchored timestamp grid. An overdue output
boundary accepts the next available source frame without inferring an input
frame gap from an integer ratio. An explicitly requested source-frame gap is
separate. Memory-pressure cadence filters normal admissions after their motion
history is updated, so controlled critical pressure cannot admit more work than
the corresponding normal selection. Pressure and smart skipping remove frames
approximately; original presentation timestamps still determine retained holds.

The GIF encoder establishes a viewer-safe schedule before exact duplicate and
palette optimization. Every emitted image record, including continuations,
lasts at least two centiseconds. Cumulative centisecond quantization avoids
adding a minimum to every input frame. A distinct interior scene without a
representable minimum hold is omitted and its predecessor remains visible.
The final scene may extend the endpoint within 20 ms. When quantization plus a
minimum terminal hold would exceed that budget, the final scene is omitted and
the predecessor holds to the rounded endpoint. No future image is advanced to
hide a short tail. The scheduler retains at most two pending indexed images;
it omits a risky terminal candidate if the existing memory guard cannot admit
that bounded ownership. Exact optimizations preserve this corrected schedule,
not an unrepresentable original timeline.

Decoded progress advances at the visible native decode boundary, independently
of cadence and smart selection. Count/time throttling bounds intermediate
reports, and successful completion reports the observed final count. Rates and
remaining-time estimates stay unknown when their measurement or denominator is
unavailable. Cancellation and errors do not report a synthetic successful tail.

The executable contracts are in
[`createPresentationSampler()`](../src/services/presentation-timing.ts),
[`decodeFrames()`](../src/services/decoder-service.ts), and
[`encodeGif()`](../src/services/gif-encoder-service.ts). The
[testing guide](../test/README.md) distinguishes source schedule correctness,
exact composited representation equivalence, and ordinary-image live playback.
