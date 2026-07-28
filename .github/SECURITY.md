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
- Optional FFmpeg and codec components are loaded from the CDN locations declared
  by the application; converted media is never sent to those services.
- The application does not use `eval()` or similar dynamic code execution.

## Development security

- OSV Scanner checks dependency changes on pull requests and performs scheduled
  full scans.
- Semgrep scans pull requests, merge-queue commits, scheduled runs, and manual
  runs. Its container image and all third-party GitHub Actions are pinned.
- Dependabot groups npm and GitHub Actions updates and delays newly published
  releases before opening routine update pull requests.
- TypeScript strict checking, Biome, Knip, circular-dependency detection, unit
  tests, browser tests, mutation tests, and duplication checks cover changes at
  different stages of CI.

## Scope

In scope are vulnerabilities in this application or its dependencies, including
injection, unsafe media handling, privacy leaks, and supply-chain issues. Browser,
codec, and CDN platform vulnerabilities should be reported to their respective
vendors unless dropconvert's integration causes the issue.
