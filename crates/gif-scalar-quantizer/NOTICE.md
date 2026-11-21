# GIF encoder source notices

The crate implements palette quantization, retained frame indices and GIF LZW
compression in `src/lib.rs`. A copy of that Rust file accompanies the browser
distribution at `/notices/gif-scalar-source.txt`. The application's license
page links to it.

`vp run build:gif-wasm:generate` refreshes the distributed source copy with
the module and its provenance. The license generator checks the two files
byte for byte before building the site.

| Material | Source and terms |
| --- | --- |
| Project contributions | Copyright PiesP. The repository [MIT license](../../LICENSE) applies to these contributions. |
| gifenc adaptations, including LZW | [gifenc 1.0.3](https://github.com/mattdesl/gifenc/tree/v1.0.3), copyright Matt DesLauriers. The [MIT notice](../../scripts/build/gifenc-LICENSE.txt) and [PNN and LZW author credits](../../scripts/build/gifenc-pnn-NOTICES.txt) accompany distributions. |
| PNN quantizer | gifenc identifies [PnnQuant.js](https://github.com/mcychan/PnnQuant.js/blob/d3de676eccec6d98efaee292d16d4536f87b0a64/src/pnnquant.js) as its source. That revision carries [MPL-2.0](LICENSE.pnn) and credits Mark Tyler, Dmitry Groshev and Miller Cy Chan. The full Rust source file containing the adaptation is available with the executable. |
| Earlier PNN implementation | The historical PnnQuant.js README identifies [nQuantCpp](https://github.com/mcychan/nQuantCpp/tree/1ffaac3a038b938e96391514e6ff412cdb599fa3), whose repository carried GPLv3. The earlier [mtPaint PNN implementation](https://github.com/wjaguar/mtPaint/blob/7ff5b87f41159e2480d3441b7fe5826a126c7868/src/memory.c#L2161) has a GPL-3.0-or-later file header. The historical [GPLv3 text](../../public/notices/pnn-upstream-gpl-3.0.txt) is included with the distribution. |

[Issue #532](https://github.com/PiesP/wasm-motion-converter/issues/532) tracks
the rights to redistribute the inherited PNN implementation under the intended
terms. The reviewed source history leaves the applicable grant from earlier
contributors unresolved.
