# dropconvert-wasm

Cloudflare Pages-ready SolidJS SPA that turns a **single video into an animated GIF or WebP** entirely in your browser using **ffmpeg.wasm**. No uploads, no servers, just client-side WASM.

🔗 **Live demo:** https://wasm-motion-converter.pages.dev/

---

## Features

- 🎯 **Single-video dropzone** with video-only validation (MP4/MOV/WebM/AVI/MKV, max 500MB)
- 🎞️ **Outputs GIF or WebP** loops in a few seconds
- 🧠 **100% client-side** with ffmpeg.wasm multithreading (SharedArrayBuffer required)
- ⚙️ **Quality & scale presets** (Low/Medium/High and 50/75/100%) for fast or high-fidelity results
- ⏱️ **Clear states**: first-run FFmpeg download (~30MB), converting with progress + elapsed time, done preview & download
- 🧭 **Environment checks** for crossOriginIsolated / SharedArrayBuffer + OPFS detection for large files
- 🌗 **Light/Dark theme** with system preference and manual toggle
- 🔒 **Privacy-first**: files never leave the browser

---

## Quick start

### For users

1. Open the web app (no install needed).
2. Drop or select a single video.
3. Pick **GIF** or **WebP**, choose quality/scale.
4. Click **Convert** and watch the progress.
5. Preview and download the result.

### For developers

Prerequisites:

- Node.js **24.12+** (Volta pinned) / engines `>=22.16.0`
- pnpm **10.26+**

Setup:

```bash
pnpm install
pnpm dev
```

Visit http://localhost:5173

---

## Development

### Available commands

```bash
# Development
pnpm dev              # Start Vite dev server

# Build & preview
pnpm build            # Production build → dist/
pnpm preview          # Preview production build

# Quality
pnpm lint             # Biome lint
pnpm lint:fix         # Biome lint with --write
pnpm fmt              # Format code
pnpm fmt:check        # Check formatting
pnpm typecheck        # TypeScript no-emit
pnpm quality          # lint + fmt:check + typecheck

# Utilities
pnpm analyze          # Bundle analysis (stats.html in dist/)
```

### Project structure

```
dropconvert-wasm/
├── src/
│   ├── components/         # SolidJS UI
│   ├── services/           # ffmpeg, conversion, analysis
│   ├── stores/             # App + conversion state (signals)
│   ├── types/              # Shared types
│   ├── utils/              # Helpers (validation, formatting, health checks)
│   ├── App.tsx             # Main SPA shell
│   └── index.tsx           # Entry point
├── public/_headers         # COOP/COEP for Cloudflare Pages
├── scripts/                # Tooling (licenses)
├── vite.config.ts          # Dev/preview headers
├── tailwind.config.ts      # Tailwind CSS 4
└── biome.jsonc             # Biome lint/format config
```

---

## Technical notes

### Stack

- SolidJS 1.9 · TypeScript 5.9 · Vite 7 · Tailwind CSS 4
- ffmpeg.wasm (versions pinned in `package.json`: `@ffmpeg/ffmpeg`, `@ffmpeg/util`)
- Biome 2.3 for lint/format

### Cross-origin isolation (SharedArrayBuffer)

FFmpeg multithreading needs COOP/COEP headers.

- **Local dev / preview** (`vite.config.ts`): ensure headers include:
  - `Cross-Origin-Embedder-Policy: require-corp`
  - `Cross-Origin-Opener-Policy: same-origin`
- **Cloudflare Pages**: keep `public/_headers` so Vite copies it to `dist/_headers`.
- Verify in the console: `crossOriginIsolated === true` and `typeof SharedArrayBuffer !== 'undefined'`.

### FFmpeg core from CDN

The app downloads ffmpeg core assets at runtime via `toBlobURL` from **unpkg** using `@ffmpeg/core-mt` (includes worker file).
Versions are pinned in `package.json` and injected into runtime helpers:

```ts
const coreVersion = getRuntimeDepVersion("@ffmpeg/core-mt");
const baseURL = `https://unpkg.com/@ffmpeg/core-mt@${coreVersion}/dist/esm`;
await ffmpeg.load({
  coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
  wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  workerURL: await toBlobURL(
    `${baseURL}/ffmpeg-core.worker.js`,
    "text/javascript"
  ),
});
```

### Presets & limits

- Quality presets trade speed vs fidelity (Low / Medium / High) for GIF/WebP output.
- Scale presets: 0.5×, 0.75×, 1× of the original video resolution.
- Timeouts: FFmpeg init 90s, video analysis 30s, conversion 5m.
- No hard duration limits; memory issues are caught at runtime and reported as appropriate errors.

### Browser compatibility

Modern browsers with SharedArrayBuffer + COOP/COEP:

| Browser           | Notes                              |
| ----------------- | ---------------------------------- |
| Chrome / Edge 92+ | Full support                       |
| Firefox 95+       | Full support                       |
| Safari 15.2+      | Requires SharedArrayBuffer support |

---

## Deployment

### Cloudflare Pages

```
Build command: pnpm install && pnpm build
Build output:  dist
Node version:  24 (or 22+ with pnpm per engines)
```

1. Connect the repo in Cloudflare Pages.
2. Deploy; `_headers` is copied automatically.
3. Verify headers and isolation:

```bash
curl -I https://your-app.pages.dev | grep -i "Cross-Origin"
```

### Other hosts

- Netlify: add the same COOP/COEP rules to `_headers`.
- Vercel: configure `vercel.json` headers for `require-corp` / `same-origin`.

## Testing

- Run the quality gate: `pnpm quality`
- Build & preview: `pnpm build && pnpm preview`
- Full checklist: see [TESTING.md](./TESTING.md)

---

## Support

- 📖 Docs: this README + [SUPPORT.md](./SUPPORT.md)
- 🐛 Bugs: open an issue with browser, OS/device, reproduction steps, and whether `crossOriginIsolated` is true
- 🔐 Security: follow [.github/SECURITY.md](./.github/SECURITY.md)

---

## Contributing

Contributions welcome! Read [CONTRIBUTING.md](./CONTRIBUTING.md) for how we work (English-only source/docs, small diffs, clear states).

---

## License

MIT for app code. FFmpeg core is **LGPL 2.1+**; comply with FFmpeg licensing when redistributing. See [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md).

---

## Roadmap

The engineering backlog and roadmap are tracked in a single place:

- `docs/TODO.md`

---

<div align="center">

**🌟 If you find this project useful, please give it a Star! 🌟**

**Made with ❤️ and GitHub Copilot by [PiesP](https://github.com/PiesP)**

</div>
