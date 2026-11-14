# Owned VP8 product fixture admission

The six quality-specific `owned-vp8-product-v8-*` Windows scenarios stage only `v8.webm` here. The
source is the M0 V8.webm control recorded in `../owned-vp8-v8.json`.

`vp run check:owned-vp8-inputs` allows this README alone for ordinary builds.
When `v8.webm` is staged, it requires the exact M0 size and SHA-256 and rejects
all other entries and symlinks before the production build. The V8 selector
requires the video, so it must be staged from the retained M0 artifact in an
isolated candidate checkout. The video is ignored by Git.
