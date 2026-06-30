# Third-Party Licenses

> Auto-generated on 2026-06-30 by `scripts/generate-licenses.ts`.
> Do not edit manually — run `pnpm build` to regenerate.

This project uses the following open-source libraries.

## Runtime Dependencies

### ffmpeg.wasm

- **Version:** (CDN)
- **License:** LGPL-2.1-or-later
- **Repository:** https://github.com/ffmpegwasm/ffmpeg.wasm
- **Purpose:** Fallback video decoding/encoding via WebAssembly (loaded via CDN at runtime)
- **Note:** Dynamically loaded at runtime via CDN, not statically bundled.

### gifenc

- **Version:** 1.0.3
- **License:** MIT
- **Repository:** https://github.com/mattdesl/gifenc
- **Purpose:** GIF encoding (quantize, applyPalette, GIFEncoder)

### mediabunny

- **Version:** 1.49.0
- **License:** MPL-2.0
- **Repository:** https://mediabunny.dev/
- **Purpose:** Video demuxing (Input, BufferSource, EncodedPacketSink)

### solid-js

- **Version:** 1.9.13
- **License:** MIT
- **Repository:** https://solidjs.com
- **Purpose:** UI framework (reactive signals, components)

### wasm-webp

- **Version:** 0.1.0
- **License:** MIT
- **Repository:** https://github.com/nieyuyao/webp-wasm/blob/main/README.md
- **Purpose:** WebP encoding via WebAssembly (encodeRGB)

## License Texts

### LGPL-2.1-or-later (ffmpeg.wasm)

LGPL-2.1-or-later. See https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html for full text.

Key points:
- ffmpeg.wasm is loaded dynamically at runtime via CDN
- This project does not statically link or modify FFmpeg source
- Users can replace the ffmpeg.wasm binary with a modified version

### MIT (gifenc, solid-js, wasm-webp)

```
MIT License

Copyright (c) respective authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MPL-2.0 (mediabunny)

Mozilla Public License Version 2.0. See https://www.mozilla.org/en-US/MPL/2.0/ for full text.

Key points:
- Source code modifications to the library itself must be made available under MPL-2.0
- This project (wasm-motion-converter) remains under MIT
- No patent retaliation clause applies

