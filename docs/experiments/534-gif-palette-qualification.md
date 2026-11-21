# Independent GIF palette and image data qualification

[Implementation brief #534](https://github.com/PiesP/wasm-motion-converter/issues/534)
defines the authoring boundary. The separate [distribution record #532](https://github.com/PiesP/wasm-motion-converter/issues/532)
identifies historical binaries, source and release decisions.

## Authorship and candidates

A fresh Codex worker received only the standalone behavioral brief, neutral ABI
contracts and its own synthetic inputs in an empty authoring directory. The
other sessions inspected the historical sources, froze the held-out inputs
and ran the comparison. The author consulted GIF89a for the packing protocol.
The component tests cover deterministic ties, RGB collisions, dictionary
resets, sub-block boundaries, invalid inputs, bounds and reusable storage.

| Variant | SHA-256 of measured WASM | Selection and image data |
| --- | --- | --- |
| Combined historical baseline | `a0753c05b7b7163a15b5608fde8189e41466da7fddd9d1eb7250ef0f3dfcf23d` | Shipping module with the #531 long-hold host correction. |
| Median control | `a9ed5fe710c0848e2d7ef1802872306b1834624673b494a488a31c6f7a6cae7d` | Weighted median split on occupied extent and population. Development comparator. |
| Variance V1 | `a7b9ae202c9ce5af0c396b8bceaadb8ead7ae9f5c8eb309ab0f4d72321631512` | Greedy population-weighted RGB565 variance, RGB888 centroids and independent nearest-color selection. |
| Variance V2 | `60907b1489b708638c5a3e684a891ca379cbfa80f6b178e30dc5e4c50fa55dfc` | Adds sparse mapping-cell centroids, independent mapping cache and independent GIF LZW. |

V1 and the median control missed the frozen long-hold animation RMSE delta at
medium (+1.039) and high (+1.171); the limit was +1.0. Fixed-palette mapping
groups the first RGB sample in each five-bit-per-channel cell. Two distinct
green bins of the RGB565 variance histogram can therefore select the same
mapped index. V2 emits one rounded prepared-RGB centroid per occupied mapper
cell when those cells fit the requested limit. Dense frames retain the
variance search. The original #490/#492 parity measurements keep their
historical binary and comparison scope.

## Prospective quality and resources

The [numeric limits](534-gif-animation-limits.json) were frozen before encoding.
The [per-condition results](534-gif-animation-screen.csv) record complete-file
bytes, both route hashes, visual error, worst-frame, accent and stationary
flicker measurements. Each quality label uses the product preparation and
palette preset. Pillow 11.1.0 independently decoded composited RGB images
and timings. The host ran the actual writer, index paths and WASM in Node
26.13.1 with a controlled selected-frame callback. This screen measures
encoding after frame ingress.

- The first seven scenes and three presets cover motion, text, accents,
  gradients, duplicate frames, colliding colors and split local-palette
  holds. V1 and the median control each passed 18/21 conditions. The low
  collision case produced one displayed record, leaving the original
  adjacent-record flicker measure undefined for every variant.
- The independent V2 cohort passed all 15 conditions. It includes unrelated
  sparse scenes, moving beacons, a local-palette hold and a pan over the
  [NASA Apollo 17 photograph](https://images.nasa.gov/details/as17-148-22727)
  with source JPEG SHA-256 `5b62bc51015e2eaee1978518b2c7e60ec67271608c6d6a8ce2a7bdc396af476f`.
  Its flicker protocol samples consecutive source intervals even when an
  encoder coalesces identical displayed frames.
- On the original observer V2 passed 20/21, including both long-hold failure
  cases. A separate source-timeline reanalysis passed 21/21. The complete
  long-hold GIFs matched the baseline bytes at all three presets. All full
  route pairs, 11 fixed preparation/mapping cases, 21 fixed LZW streams and
  fixed writer outputs agreed.
- Both frozen cohorts used gates SHA-256 `bf18d5395c74d130a2c35469cc34e35771f76c3f74ee566b37e35bba48b369b4`.
  The original and second freeze-manifest SHA-256 values were
  `e2eba13357b3c4529029eba80a664e3d59f0c57426a48917fd015da7d47ba9a1` and
  `20a867f9f0cb67cf3df7940143cdb65451b3ba3dd765d470b02a8523241f120a`.
  For the fixed-input ABI probe, V2 required explicit host admission of
  space for the test vector. Both the initial harness failure and its
  grow-before-reserve correction were retained.
- V2 takes 28,753 bytes raw and 12,355 bytes under gzip level 9. Initial
  linear memory is 3,145,728 bytes. At 720 × 720, the retained route peaked
  at 6,291,456 steady and 9,437,184 old plus new bytes during growth. At
  1920 × 1080 it retained indices at 15,597,568 steady bytes. At 3840 × 2160
  it used the JS-held path at 36,372,480 steady and 39,518,208 overlap bytes.
  Cancellation, injected admission failure and successful reuse released JS
  pool leases. On exceptional exit the final WASM handle could remain until
  its entire conversion instance was discarded.

## Product tradeoff

Installed Edge 158.0.4370.33 decoded the private 720 × 720 primary workload
to 134 displayed frames over 11.16 s with a perpetual loop. With the same
host and medium settings, baseline output was 19,607,211 bytes. V1 and V2
produced identical 25,802,778-byte files (+31.6%). Both fit the 96 MiB output
ceiling. The maintainer accepted this increase specifically for that original
input on 22 November 2026, conditional on all remaining gates passing.
The private media and saved conversions stay outside the distribution.
See #532 for first/warm product measurements, browser coverage, release
identity and outstanding gates.
