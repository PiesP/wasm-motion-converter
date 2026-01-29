# Security Policy

This document explains how to report security issues for **dropconvert-wasm**.

## Supported versions

Security support is provided for the latest released version.

## Reporting a vulnerability

Do not disclose vulnerabilities publicly.

1. Preferred: use GitHub Security Advisories for this repository.
2. If unavailable, open a minimal GitHub issue asking for a private channel without technical details.

Include, where possible:

- Short description and impact
- Steps to reproduce
- Browser and OS
- Relevant console logs

## Security model & privacy

- All conversion runs locally in the browser.
- No user file uploads by design.
- FFmpeg core assets are downloaded from a CDN (unpkg) at runtime.
