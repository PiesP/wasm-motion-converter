# dropconvert

SolidJS SPA that converts a single video into GIF or animated WebP entirely in the browser. It prefers WebCodecs when available and falls back to FFmpeg (ffmpeg.wasm) when needed. No uploads, no servers.

Live demo: https://wasm-motion-converter.pages.dev/

## Features

- Single-video dropzone with video-only validation
- GIF/WebP output with quality + scale presets
- WebCodecs-first conversion with FFmpeg fallback
- Fully client-side conversion (SharedArrayBuffer required)
- Clear progress, elapsed time, and preview/download flow
- Environment checks for `crossOriginIsolated` / `SharedArrayBuffer`
- Offline/network warning banner and downloadable diagnostics logs
- Runtime dependency loading with CDN fallback and generated integrity metadata
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
- WebCodecs is the preferred conversion path; FFmpeg is the fallback
- FFmpeg core assets are loaded at runtime with `toBlobURL()` from blob-compatible CDN providers (`jsdelivr`, `unpkg`)
- Runtime ESM dependencies use the generated import map and CDN fallback configuration from `vite.config.ts`
- `pnpm build` runs `prebuild`, which generates `public/cdn-integrity.json` and `public/LICENSES.md`
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

MIT for app code. FFmpeg core is LGPL 2.1+. See [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md).
