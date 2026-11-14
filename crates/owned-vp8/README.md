# Bounded VP8 feasibility experiment

This is an **experimental** keyframe-only writer, not a product encoder. It
accepts bounded opaque RGBA/BGRA input and encodes 4:2:0 DC residuals. It
omits AC coefficients, so edges, text, and chroma detail have poor quality.
The q60/75/85 quantizers are exploratory and do not qualify preset fidelity
or removal of `wasm-webp`.

The bitstream and coefficient update probabilities follow [RFC 6386](https://www.rfc-editor.org/rfc/rfc6386.html),
sections 7, 9, 11 and 13.4. RFC 6386 is Copyright (c) 2011 IETF Trust and the
identified contributors; the static probability table is a format constant,
not imported encoder source. The implementation is original Rust under MIT.
The [W3C VP8 WebCodecs registration](https://www.w3.org/TR/webcodecs-vp8-codec-registration/)
defines raw `EncodedVideoChunk` keyframe bytes; browser support must be probed.

The v1 ABI accepts one copied input reservation and publishes a borrowed output
until reset or the next reservation, including a failed reservation. A caller
must refresh JS views after any WASM growth, copy the output before reuse, and
keep one conversion per instance. Return codes are 0 success, 1 invalid input,
2 unsupported pixels (nonopaque input), and 3 output limit. Input is bounded to
2048 pixels on each axis, 4,194,304 pixels total, and 16 MiB. Output is bounded
to 4 MiB. This crate has no external Cargo dependencies.
