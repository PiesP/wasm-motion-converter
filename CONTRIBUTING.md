# Contributing

Thanks for helping improve **dropconvert-wasm**! This is a Cloudflare Pages-ready **Vite + SolidJS + TypeScript** SPA that converts a single video to GIF or WebP entirely **in the browser** with **ffmpeg.wasm** (no uploads).

## Where to communicate

- **Bug reports / feature requests:** GitHub Issues
- **Security & privacy issues:** follow `.github/SECURITY.md`
- **Questions/ideas:** GitHub Discussions (if enabled)

## Before opening an issue

Please check:

- `README.md` and `SUPPORT.md`
- Existing issues (avoid duplicates)

### Bug reports: include diagnostics

To keep reports actionable, include:

- Browser + version
- OS + device type (desktop / mobile / tablet)
- Expected vs. actual behavior
- Exact repro steps
- Input video details (format, codec, resolution, file size)
- Console/network output, especially:
  - `typeof SharedArrayBuffer`
  - `crossOriginIsolated`

DevTools snippet:

```js
({
  sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  crossOriginIsolated,
});
```

Please avoid attaching sensitive or private files.

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

- Cross-origin isolation headers are configured in `vite.config.ts` for dev/preview.
- First run will download ~30MB of ffmpeg core from the CDN.

### Quality checks (run before PRs)

- `pnpm lint`
- `pnpm fmt:check`
- `pnpm typecheck`
- `pnpm build`
- Or run the bundle: `pnpm quality`

## Project constraints (must keep)

- **No server upload:** files stay in-browser.
- **SharedArrayBuffer / COOP+COEP required:**
  - Cloudflare Pages: `public/_headers`
  - Local dev/preview: `vite.config.ts` headers
- **FFmpeg core from CDN:** loaded at runtime via `toBlobURL` using `@ffmpeg/core-mt` from unpkg (worker file included).

## Code style

- Source code, comments, and docs are **English only**.
- Keep diffs small and focused; preserve clear loading/progress/error states.
- Prefer explicit, user-visible feedback for long-running actions.

## Code Review Checklist (Enforced)

All pull requests must adhere to the following **import structure rules**. These are verified during code review:

### ✅ Required (Import Patterns)

- [ ] **Alias imports only:** All internal imports use `@alias/module` (e.g., `@components/Button`, `@services/conversion-service`)
- [ ] **Leaf module imports:** No barrel imports (e.g., `❌ @components`, `✅ @components/Button`)
- [ ] **No relative imports:** Deeply nested imports use aliases, not `../` paths
- [ ] **No absolute `src/` paths:** Never `src/components/Button`; use `@components/Button`

### ❌ Forbidden (Will be requested to fix)

| Pattern          | Example                            | Reason                                      |
| ---------------- | ---------------------------------- | ------------------------------------------- |
| Barrel imports   | `import x from "@components"`      | Defeats tree-shaking; obscures dependencies |
| Relative imports | `import x from "../utils/logger"`  | Fragile during refactoring; unscalable      |
| Absolute `src/`  | `import x from "src/utils/logger"` | Bypasses alias safety; inconsistent         |

### Example PR Check

**Before (❌ rejected):**

```typescript
import { Button } from "@components"; // Barrel
import { logger } from "../utils/logger"; // Relative
import { Task } from "src/types/task-types"; // Absolute src/
```

**After (✅ approved):**

```typescript
import { Button } from "@components/Button";
import { logger } from "@utils/logger";
import type { Task } from "@types/task-types";
```

**Why this matters:**

- Easier refactoring (move files without breaking imports)
- Better tree-shaking (dead code elimination)
- Clearer module boundaries (circular dependency prevention)
- Consistent IDE navigation across the codebase

For detailed import rules, see [CODE_STANDARDS.md](CODE_STANDARDS.md#1-file-organization).

## License

By contributing, you agree your contributions are licensed under the project license (see `LICENSE` and `public/LICENSES.md`).
