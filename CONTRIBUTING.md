# Contributing

Thanks for improving **dropconvert-wasm**. This is a Vite + SolidJS + TypeScript SPA that converts a single video to GIF/WebP entirely in the browser (no uploads).

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

- Node.js 24.12+ (Volta) / engines `>=22.16.0`
- pnpm 10.26+

### Install

```bash
pnpm install
```

### Run locally

```bash
pnpm dev
```

- COOP/COEP headers are configured in `vite.config.ts` for dev/preview.
- First run downloads ~30MB ffmpeg core from the CDN.

### Quality checks (run before PRs)

- `pnpm lint`
- `pnpm fmt:check`
- `pnpm typecheck`
- `pnpm build`
- Or run: `pnpm quality`

## Project constraints

- No server upload (files stay in-browser).
- SharedArrayBuffer requires COOP/COEP headers:
  - Cloudflare Pages: `public/_headers`
  - Local dev/preview: `vite.config.ts`
- FFmpeg core is loaded from CDN at runtime (`@ffmpeg/core-mt` via unpkg).

## Code style

- Source, comments, and docs are English only.
- Keep diffs small and focused; keep loading/progress/error states intact.
- Provide explicit user feedback for long-running actions.

## Import rules (enforced)

- Use alias-based, leaf imports for cross-folder modules.
- No barrel imports.
- No deep relative imports (`../`) across folders.
- No `src/` absolute paths.

Example:

```typescript
import { Button } from "@components/Button";
import { logger } from "@utils/logger";
import type { Task } from "@t/task-types";
```

See [CODE_STANDARDS.md](./CODE_STANDARDS.md#1-file-organization) for details.

## License

By contributing, you agree your contributions are licensed under the project license (see [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md)).
