# Security Policy

## Supported versions

Security support is provided for the latest released version. Older deployments
are not maintained, so users should keep the application up to date.

## Reporting a vulnerability

Do not disclose vulnerabilities publicly. Use
[GitHub Security Advisories](https://github.com/PiesP/wasm-motion-converter/security/advisories/new)
for this repository. If that is unavailable, open a minimal GitHub issue asking
for a private channel without including technical details.

Include the impact, reproduction steps, browser and operating system, and any
relevant console logs. We aim to respond within seven business days and will
coordinate disclosure after a fix is available.

## Security and privacy model

- Conversion runs locally in the browser; user media is not uploaded for
  server-side processing.
- WebCodecs handles decoding. MediaBunny, wasm-webp, gifenc, and other runtime
  code are bundled at build time instead of loaded from a runtime CDN.
- The application does not use `eval()` or similar dynamic code execution.
- COOP/COEP headers provide the cross-origin security boundary and make
  `SharedArrayBuffer` available. The current single-threaded WASM encoders do
  not require `SharedArrayBuffer` or cross-origin isolation.
- Dependency, static-analysis, browser, and advisory review gates cover changes
  at different stages. Scanner findings and artifacts can contain source
  excerpts or vulnerability details and require human validation before
  remediation or severity decisions.

## Scope

Report vulnerabilities in this application or its dependencies, including
injection, unsafe media handling, privacy leaks, and supply-chain issues.
Browser, codec, and platform vulnerabilities belong with their respective
vendors unless dropconvert's integration causes the issue.
