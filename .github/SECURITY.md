# Security Policy

This document explains how security is handled for **dropconvert** and how to
responsibly report vulnerabilities.

## Supported versions

Security support is provided for the latest released version. Users should keep
the application up to date because older deployments are not maintained.

## Reporting a vulnerability

Do not disclose vulnerabilities publicly.

1. Preferred: use GitHub Security Advisories for this repository.
2. If unavailable, open a minimal GitHub issue asking for a private channel without technical details.

Include, where possible:

- Short description and impact
- Steps to reproduce
- Browser and OS
- Relevant console logs

We aim to respond within 7 business days and coordinate disclosure after a fix
is available.

## Security model & privacy

- All conversion runs locally in the browser.
- No user file uploads by design.
- WebCodecs is the primary conversion engine; all processing runs locally in the browser.
- MediaBunny, wasm-webp, gifenc, and other runtime code are bundled at build time;
  the application does not load runtime code from a CDN.
- The application does not use `eval()` or similar dynamic code execution.

## Development security

- OSV Scanner checks dependency changes on pull requests and performs daily full scans.
- Semgrep scans pull requests, merge-queue commits, scheduled runs, and manual
  runs. Its container image and all third-party GitHub Actions are pinned.
- Dependabot checks npm packages and GitHub Actions daily. Both Dependabot and
  pnpm retain a 24-hour supply-chain cooling window; pnpm also rejects recent
  trust-level downgrades and unapproved dependency build scripts.
- A daily freshness check covers pinned Nose, OSV Scanner, and Semgrep releases
  that Dependabot cannot update directly. It also checks the pinned Codex
  Security CLI package after the same 24-hour cooling window. Major upgrades
  remain manual.
- TypeScript strict checking, Biome, Knip, circular-dependency detection, unit
  tests, browser tests, mutation tests, and duplication checks cover changes at
  different stages of CI.
- Codex Security adds an advisory, source-to-sink review of eligible same-repository
  pull requests and supports manually dispatched full scans. It complements, and
  does not replace, deterministic CodeQL, OSV, Semgrep, test, or browser gates.
  Enable it by setting the `CODEX_SECURITY_ENABLED` repository variable to
  `true` and the `CODEX_SECURITY_API_KEY` Actions secret.
- Local report-only checks are available through `pnpm security:codex:dry-run`,
  `pnpm security:codex:working-tree`, `pnpm security:codex:branch`, and
  `pnpm security:codex:full`. Local authenticated scans default to ChatGPT login.
- Scan artifacts can contain source excerpts and vulnerability details. CI keeps
  them for seven days, and a human must validate findings and deferred coverage
  before remediation or severity gating.

## Scope

In scope are vulnerabilities in this application or its dependencies, including
injection, unsafe media handling, privacy leaks, and supply-chain issues. Browser,
codec, and platform vulnerabilities should be reported to their respective
vendors unless dropconvert's integration causes the issue.
