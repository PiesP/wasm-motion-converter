# dropconvert-wasm

SolidJS SPA that converts a single video into GIF/WebP entirely in the browser using FFmpeg (ffmpeg.wasm). No uploads, no servers.

Live demo: https://wasm-motion-converter.pages.dev/

## Features

- Single-video dropzone with video-only validation
- GIF/WebP output with quality + scale presets
- Fully client-side conversion (SharedArrayBuffer required)
- Clear progress, elapsed time, and preview/download flow
- Environment checks for crossOriginIsolated / SharedArrayBuffer
- Light/dark theme

## Quick start (dev)

Prerequisites: Node.js 24.12+ (Volta) / engines `>=22.16.0`, pnpm 10.26+

```bash
pnpm install
pnpm dev
```

Local: http://localhost:5173

## Commands

```bash
pnpm dev
pnpm build
pnpm preview
pnpm lint
pnpm lint:fix
pnpm fmt
pnpm fmt:fix
pnpm typecheck
pnpm quality
```

## Technical notes

- COOP/COEP headers are required for SharedArrayBuffer:
  - Cloudflare Pages: `public/_headers`
  - Local dev/preview: `vite.config.ts`
- FFmpeg core is loaded from CDN at runtime (`@ffmpeg/core-mt` via unpkg)
- Build output: `dist/`

## Testing

- `pnpm quality`
- `pnpm build && pnpm preview`
- Manual checklist: [TESTING.md](./TESTING.md)

## Support

- Docs: [README.md](./README.md) + [SUPPORT.md](./SUPPORT.md)
- Bugs/features: GitHub Issues
- Security: [.github/SECURITY.md](./.github/SECURITY.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT for app code. FFmpeg core is LGPL 2.1+. See [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md).

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
