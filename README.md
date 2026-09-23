# dropconvert

[한국어](./README.ko.md) | [日本語](./README.ja.md)

Convert a local video to an animated GIF or WebP without uploading it.
dropconvert runs entirely in the browser and bundles all runtime code with the
application.

[Open dropconvert](https://wasm-motion-converter.pages.dev/)

## How to use it

1. Select a video from your device. The file stays in your browser.
2. Choose GIF or WebP, a quality preset, and an output scale. If the browser can
   read the video's duration, you can also select a shorter clip.
3. Start the conversion, then preview and download the result. Progress and
   cancellation controls remain available while conversion is running.

## Browser requirements

dropconvert requires WebCodecs (`VideoDecoder` and `VideoFrame`) and
WebAssembly. Input codec support varies by browser and operating system; the app
checks the selected file and reports unsupported configurations.

Cross-Origin-Opener-Policy (COOP) and Cross-Origin-Embedder-Policy (COEP)
headers remain enabled as a security boundary and make `SharedArrayBuffer`
available. The current single-threaded WASM encoders do not require
`SharedArrayBuffer` or cross-origin isolation.

Video conversion can use substantial CPU and memory. Shorter clips, lower
quality, and a smaller output scale reduce the workload.

## Privacy

Conversion, preview, and output generation happen locally in the browser. The
application does not upload media for server-side processing and does not load
runtime code from a CDN.

## Development

This project is developed with assistance from AI tools. Setup and validation
instructions are in [Contributing](./CONTRIBUTING.md); test profiles and fixtures
are in the [testing guide](./test/README.md).

## Support

- Usage questions and troubleshooting: [Support](./SUPPORT.md)
- Bugs and feature requests: [GitHub Issues](https://github.com/PiesP/wasm-motion-converter/issues)
- Vulnerabilities and privacy concerns: [Security policy](./.github/SECURITY.md)

## License

MIT. See [LICENSE](./LICENSE) and [third-party licenses](./public/LICENSES.md).
