# Owned VP8 V17 prospective fixed-pixel qualification

V17 contains twenty independent packed RGBA inputs, each evaluated at q60,
q75, and q85. The fixed-pixel limits are PSNR at least primary minus 1 dB,
SSIM at least primary minus 0.01, and encoded size at most the greater of
1.25 times primary and primary plus 128 bytes. Every condition must pass.
The attempt budget is one, including an interrupted or failed preflight.
Primary comparison uses the exact patched wasm-webp JS and WASM from V16.

V16 completed all 60 conditions, passing 55. Its five failures were size-only.
The original manifest and first outcome are preserved by the separate V16
disposition. The new comparator admits V16 only as an exposed regression.
It exposes all 60 V16 conditions alongside the earlier 867.

## Inputs

Twelve generated sources cover neutral and near-neutral luma, dark ramps,
glyphs, diagonal chroma, saturated boundaries, deterministic noise, mixed
curvature, tiny and odd geometry, a wide strip, and a large admitted image.
Four crops come from Thennicke's *National Gallery at dusk, Canberra ACT*,
under CC BY-SA 4.0. Four resized video frames come from Xocolatl's
*Wasserstufen*, under CC BY-SA 4.0. The source descriptions, revisions,
available originals, attributions, sizes, hashes, licenses and transforms are
pinned in the fixture manifest.
[Photo revision](https://commons.wikimedia.org/w/index.php?title=File:National_Gallery_at_dusk,_Canberra_ACT.jpg&oldid=1100210507) ·
[Video revision](https://commons.wikimedia.org/w/index.php?title=File:Wasserstufen.webm&oldid=1034149324) ·
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

The packed pixels use alpha 255. Photo crops use the original storage axes
and bicubic scaling. The video selections are the first video packets at
or after public predeclared absolute times. Exact packet PTS are 1709,
5679, 9717 and 14455 at time base 1/1000. The source-only generation
checked that all 20 packed digests differ from each other, the 927 exposed
conditions, and the 30 predetermined development inputs. It produced
digest metadata with zero candidate and primary encodes. Original media
and evidence are retained outside this Git checkout and delivered assets.

## Admission

Use the maintained private one-shot coordinator. It checks a signed
registry, a signed remote candidate and its prebuilt WASM/provenance,
the exact 927 passing exposed rows, original-reference whole-animation
readback for 77, 115 and 192 frames, and first/warm AB and BA indicative
records for the same candidate and all three presets. The exposed lock must
match the full frozen tool map and Node executable. The admission lock
names the signed registry and tree, candidate and tree, Gitlink, module,
comparator, ABI driver, fixtures, patched primary, and product witnesses.

Registration is an unedited GitHub issue #501 owner comment that binds the
exact lock. The coordinator reserves the sole private attempt directory
before preflight. The child checks the descriptor-bound read-only request,
admission and owner readback, then verifies signed identities and the
prebuilt module and comparator before reading original media. Every row
retains the raw VP8 digest, decoded RGB evidence, source pin, numerical
gates and ABI accounting. Earlier completed or failed attempts retain
their original identities and artifacts.

Fresh fixed-pixel quality, balanced whole-product timing, resource and
cancellation evidence, browser coverage, runtime assets and served-byte
delivery remain distinct qualification checks.
