# Security Policy

This document describes how security is handled for **dropconvert-wasm** and how to responsibly report vulnerabilities.

---

## Supported Versions

We only provide security support for the **latest released version** deployed on [Cloudflare Pages](https://piesp.github.io/wasm-motion-converter/).

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

---

## Reporting a Vulnerability

If you discover a security vulnerability, **do not** disclose it publicly.

1. **Preferred**: Use [GitHub Security Advisories](https://github.com/PiesP/wasm-motion-converter/security/advisories/new).
2. If that is not available, open a minimal GitHub issue asking for a private channel **without** sharing technical details.

Please include, where possible:

- A short description and impact
- Steps to reproduce
- Browser and OS
- Relevant console logs

We aim to respond within **7 business days** and coordinate disclosure once a fix is available.

---

## Security Model & Privacy

**dropconvert-wasm** is a client-side SPA that runs entirely in your browser.

- All video conversion runs locally in the browser using FFmpeg WASM.
- **No file uploads** by design — user files never leave the browser.
- No user data is collected, stored, or transmitted.
- The script does not use `eval()`, `new Function()`, or similar dynamic code execution.
- Test helpers (`__TEST_HELPERS__`) are gated behind `import.meta.env.DEV` and tree-shaken out of production builds.

### CDN Dependencies

FFmpeg core assets and third-party libraries are loaded at runtime from CDN with Subresource Integrity (SRI) verification:

- `@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core-mt` — jsDelivr (SRI: sha384)
- `solid-js`, `solid-js/web`, `solid-js/store` — esm.sh / jsDelivr (SRI: sha384)
- `mp4box`, `web-demuxer` — esm.sh (SRI: sha384)

CDN URLs use pinned versions from `cdnDependencies` in `package.json`. The service worker verifies SHA-384 integrity via `crypto.subtle.digest` before caching.

### Content Security Policy

The app enforces a strict CSP via Cloudflare Pages headers (`public/_headers`):

- `default-src 'self'`
- `script-src 'self' 'wasm-unsafe-eval'` + CDN origins (required for FFmpeg WASM and dynamic imports)
- `worker-src 'self' blob:` (required for FFmpeg worker threading)
- `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`
- `require-trusted-types-for 'script'` (DOM XSS protection)
- Cross-origin isolation headers (`COEP: require-corp`, `COOP: same-origin`) for `SharedArrayBuffer`

### Security Headers

- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

## Development Security

We use several mechanisms to keep the codebase secure:

- **GitHub Security Suite** (`.github/workflows/security.yaml`)
  - Dependency scanning with OSV Scanner (PR diff + scheduled full scans)
  - Static analysis with Semgrep on PR, scheduled, and manual runs (`p/typescript`, `p/javascript`, `p/security-audit`, `p/secrets`)
- **Dependabot** (`.github/dependabot.yaml`)
  - Automated grouped updates for npm packages and GitHub Actions
- **Quality**
  - TypeScript strict mode, Biome linter/formatter, circular dependency detection

---

## Scope

In scope for this policy:

- Vulnerabilities in this application (XSS, injection, logic flaws, privacy leaks)
- CDN integrity bypass or cache poisoning
- Vulnerabilities introduced by this repository's dependencies
- Test helper exposure in production builds

Out of scope:

- Issues in the FFmpeg project itself
- Issues in Cloudflare's CDN infrastructure
- Browser-level vulnerabilities (SharedArrayBuffer, WASM, etc.)

---

## License

This project is licensed under the [MIT License](../LICENSE).
