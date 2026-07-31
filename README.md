# dropconvert

Convert a video to an animated GIF or WebP without uploading it. dropconvert
runs entirely in the browser and bundles all runtime code with the application.

[Open dropconvert](https://wasm-motion-converter.pages.dev/)

## Features

- GIF and animated WebP output with quality and scale presets
- WebCodecs decoding with MediaBunny demuxing
- Local encoding with OffscreenCanvas, wasm-webp, and gifenc
- Progress, elapsed time, cancellation, preview, and download states
- Environment checks and downloadable diagnostic logs
- No uploads, server-side processing, or runtime CDN dependencies

## Browser requirements

The application requires WebCodecs, `SharedArrayBuffer`, and cross-origin
isolation. It checks these capabilities before conversion and reports missing
requirements in the browser.

## Development

Use the toolchain pinned in `package.json`, or versions that satisfy its
`engines` fields. Initialize the shared browser-core submodule before installing.

```bash
git submodule update --init --recursive
pnpm install
pnpm dev
```

The development server runs at <http://localhost:5173>.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the development server |
| `pnpm test` | Run the Vitest suite |
| `pnpm test:cov` | Run unit tests with coverage thresholds |
| `pnpm test:e2e:ci` | Generate the CI fixture and run the CI Playwright profile |
| `pnpm test:e2e:resource` | Run the opt-in Chromium CPU and memory profile on Linux |
| `pnpm quality` | Run formatting, lint, type, i18n, dependency, and source checks |
| `pnpm verify` | Run the quality gate and production CI build |
| `pnpm verify:full` | Add coverage and browser tests to `verify` |

## Technical notes

- COOP/COEP headers are configured in `public/_headers` for Cloudflare Pages and
  in `vite.config.ts` for local development and preview.
- Video decoding: WebCodecs VideoDecoder + MediaBunny demuxer
- Encoding: OffscreenCanvas WebP, wasm-webp, and gifenc (GIF)
- Build output: `dist/`

## Testing

See the [testing guide](./test/README.md) for test profiles, fixtures, and focused
commands.

## Support

- Usage questions and troubleshooting: [Support](./SUPPORT.md)
- Bugs and feature requests: [GitHub Issues](https://github.com/PiesP/wasm-motion-converter/issues)
- Vulnerabilities and privacy concerns: [Security policy](./.github/SECURITY.md)

## Contributing

See [Contributing](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE) and [third-party licenses](./public/LICENSES.md).
