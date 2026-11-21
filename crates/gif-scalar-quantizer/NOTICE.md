# GIF encoder source notices

The palette, fixed-palette mapper and image-data compressor were written for
[this implementation brief](https://github.com/PiesP/wasm-motion-converter/issues/534)
by a fresh Codex author session in an isolated folder. The session received
the brief, neutral input/output and memory contracts, and its own synthetic
fixtures. It consulted the GIF89a specification for LZW. The historical PNN
implementations, vendor code and held-out fixtures were restricted to the
provenance and validation reviewers.
The LZW encoder emits GIF89a image data using the fixed-index bitstream contract. The integration retains project preparation,
index ownership and the TypeScript host writer. The matching source bundle at
`/notices/gif-source.json` lists the files under their build-relative paths,
their full text and hashes, the compiler flags and the exact WASM digest.
Restore the files under their listed paths and run the recorded offline Cargo
command from the crate with the pinned Rust toolchain and flags.

The historical [shipping source and notices](https://github.com/PiesP/wasm-motion-converter/tree/02f1cc2188b83a7047f57f9b1ca8880ca74d5ec1)
belong to the earlier PNN binary. Its SHA-256 is
`a0753c05b7b7163a15b5608fde8189e41466da7fddd9d1eb7250ef0f3dfcf23d`.

| Material | Source and terms |
| --- | --- |
| Project contributions | Copyright PiesP. The repository [MIT license](../../LICENSE) applies to these contributions. |
| Host container layout and expanding output buffer; historical LZW | [gifenc 1.0.3](https://github.com/mattdesl/gifenc/tree/v1.0.3), copyright Matt DesLauriers. The [MIT notice](../../scripts/build/gifenc-LICENSE.txt) and [PNN and LZW author credits](../../scripts/build/gifenc-pnn-NOTICES.txt) accompany distributions. |
| Historical PNN quantizer | gifenc identifies [PnnQuant.js](https://github.com/mcychan/PnnQuant.js/blob/d3de676eccec6d98efaee292d16d4536f87b0a64/src/pnnquant.js) as its source. That revision carries [MPL-2.0](LICENSE.pnn) and credits Mark Tyler, Dmitry Groshev and Miller Cy Chan. The historical shipping revision linked above preserves that adaptation. |
| Earlier PNN implementation | The historical PnnQuant.js README identifies [nQuantCpp](https://github.com/mcychan/nQuantCpp/tree/1ffaac3a038b938e96391514e6ff412cdb599fa3), whose repository carried GPLv3. The earlier [mtPaint PNN implementation](https://github.com/wjaguar/mtPaint/blob/7ff5b87f41159e2480d3441b7fe5826a126c7868/src/memory.c#L2161) has a GPL-3.0-or-later file header. The historical [GPLv3 text](../../public/notices/pnn-upstream-gpl-3.0.txt) is included with the distribution. |

[Issue #532](https://github.com/PiesP/wasm-motion-converter/issues/532) tracks
the rights to redistribute the inherited PNN implementation under the intended
terms. The reviewed source history leaves the applicable grant from earlier
contributors unresolved.
