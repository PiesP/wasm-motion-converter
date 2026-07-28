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

- Use the Volta versions in `package.json` (currently Node.js `26.5.0` and pnpm
  `11.17.0`), or engines-compatible Node.js `>=22.13.0` and pnpm `>=11.17.0`.

### Install

```bash
pnpm install
```

### Run locally

```bash
pnpm dev
```

- COOP/COEP headers are configured in `vite.config.ts` for dev/preview.

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
- Video decoding: WebCodecs VideoDecoder + MediaBunny demuxer
- Encoding: OffscreenCanvas WebP, wasm-webp, gifenc (GIF)
- No runtime CDN dependencies — all code is bundled at build time

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

## Dependency update policy

- Prefer current stable libraries and tools; this project intentionally adopts
  modern platform and ecosystem capabilities quickly.
- pnpm and Dependabot enforce a 24-hour cooling window for newly published
  packages. Do not bypass it for routine updates.
- Dependabot checks npm packages and GitHub Actions daily. Passing patch/minor
  updates from the reviewed tooling allowlist may auto-merge; majors and runtime
  behavior changes require manual review.
- `package.json`, `pnpm-workspace.yaml`, and pinned workflow digests are the
  authoritative versions. Run `pnpm verify:full` after substantive upgrades.

## License

By contributing, you agree your contributions are licensed under the project license (see [LICENSE](./LICENSE) and [public/LICENSES.md](./public/LICENSES.md)).
