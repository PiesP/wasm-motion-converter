# Contributing

Thanks for improving **dropconvert**. This is a Vite + SolidJS + TypeScript SPA that converts a single video to GIF/WebP entirely in the browser (no uploads).

## Communication

- Bugs/features: GitHub Issues
- Security/privacy: see [.github/SECURITY.md](./.github/SECURITY.md)
- Questions: GitHub Discussions (if enabled)

## Before opening an issue

- Read [README.md](./README.md) and [SUPPORT.md](./SUPPORT.md)
- Check existing issues

### Bug reports: include diagnostics

- Browser + version
- OS + device type
- Expected vs. actual behavior
- Exact repro steps
- Input video details (format, codec, resolution, file size)
- DevTools values: `typeof SharedArrayBuffer`, `crossOriginIsolated`

DevTools snippet:

```js
({
  sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  crossOriginIsolated,
});
```

Avoid attaching sensitive or private files.

## Development setup

### Prerequisites

- Volta Node.js `24.15.0` (project default) or engines-compatible Node.js `>=22.16.0`
- pnpm `>=10.29.2`

### Install

```bash
pnpm install
```

### Run locally

```bash
pnpm dev
```

- COOP/COEP headers are configured in `vite.config.ts` for dev/preview.
- First run downloads ~30MB ffmpeg core from the CDN (fallback path).

### Quality checks (run before PRs)

- `pnpm quality`
- `pnpm build`
- Optional focused checks: `pnpm lint`, `pnpm fmt`, `pnpm check`, `pnpm knip`
- Use `pnpm quality:fix` if you want to apply the repository-standard format/lint fixes before rerunning `pnpm quality`.

## Project constraints

- No server upload (files stay in-browser).
- SharedArrayBuffer requires COOP/COEP headers:
  - Cloudflare Pages: `public/_headers`
  - Local dev/preview: `vite.config.ts`
- WebCodecs is the preferred conversion path; FFmpeg is the fallback.
- FFmpeg core assets are loaded at runtime with `toBlobURL()` from blob-compatible CDN providers.

## Code style

- Source, comments, and docs are English only.
- Keep diffs small and focused; keep loading/progress/error states intact.
- Provide explicit user feedback for long-running actions.
- Use alias-based, leaf imports for cross-folder modules.

## Import rules (enforced)

- Use alias-based, leaf imports for cross-folder modules.
- No barrel imports.
- No deep relative imports (`../`) across folders.
- No `src/` absolute paths.

Example:

```typescript
import { Button } from "@components/Button";
import { logger } from "@utils/logger";
import type { ConversionSettings } from "@t/conversion-types";
```

See [CODE_STANDARDS.md](./CODE_STANDARDS.md#1-file-organization) for details.

## License

By contributing, you agree your contributions are licensed under the project license (see [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md)).
