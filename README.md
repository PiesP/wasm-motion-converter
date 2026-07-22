# dropconvert

SolidJS SPA that converts a single video into GIF, animated WebP, or animated AVIF entirely in the browser. Uses WebCodecs VideoDecoder + MediaBunny for demuxing and OffscreenCanvas/wasm-webp/gifenc/libavif for encoding. No uploads, no servers, no CDN.

Live demo: https://wasm-motion-converter.pages.dev/

## Features

- Single-video dropzone with video-only validation
- GIF/WebP/AVIF output with quality + scale presets
- WebCodecs-based decoding with MediaBunny demuxer
- Fully client-side conversion (SharedArrayBuffer required)
- Clear progress, elapsed time, and preview/download flow
- Environment checks for `crossOriginIsolated` / `SharedArrayBuffer`
- Offline/network warning banner and downloadable diagnostics logs
- Dark theme (Linear-style)

## Quick start (dev)

Prerequisites: Volta Node.js `26.3.0` (project default) or engines-compatible Node.js `>=22.0.0`, pnpm `>=10.29.2`

```bash
pnpm install
pnpm dev
```

Local: http://localhost:5173

## Commands

```bash
pnpm dev
pnpm check
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm fmt
pnpm fmt:fix
pnpm knip
pnpm quality
pnpm quality:fix
pnpm build
pnpm preview
```

## Technical notes

- COOP/COEP headers are required for SharedArrayBuffer:
  - Cloudflare Pages: `public/_headers`
  - Local dev/preview: `vite.config.ts`
- Video decoding: WebCodecs VideoDecoder + MediaBunny demuxer
- Encoding: OffscreenCanvas WebP, wasm-webp, gifenc (GIF), libavif v1.4.2 + libaom v3.14.1 (animated AVIF)
- No runtime CDN dependencies — all code is bundled at build time
- `pnpm build` runs quality checks + Vite build + postbuild
- Build output: `dist/`

## Testing

- `pnpm quality`
- `pnpm build`
- `pnpm preview`
- Manual checklist: [TESTING.md](./TESTING.md)

## Support

- Docs: [README.md](./README.md) + [SUPPORT.md](./SUPPORT.md)
- Bugs/features: GitHub Issues
- Security: [.github/SECURITY.md](./.github/SECURITY.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md).
