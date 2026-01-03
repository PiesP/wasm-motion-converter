# Security Policy

This document describes how security is handled for **dropconvert-wasm** and how to responsibly report vulnerabilities.

## Supported Versions

Security support is provided for the **latest released version**.

## Reporting a Vulnerability

If you discover a security vulnerability, **do not** disclose it publicly.

1. Preferred: use **GitHub Security Advisories** for this repository.
2. If that is not available, open a minimal GitHub issue asking for a private channel **without** sharing technical details.

Please include, where possible:

- A short description and impact
- Steps to reproduce
- Browser and OS
- Any relevant console logs

## Security Model & Privacy

dropconvert-wasm is a **client-side web application**:

- All conversion logic executes locally in the browser.
- The application is designed to avoid uploading user files to a server.
- The app downloads ffmpeg core assets from a CDN (unpkg) at runtime.

## Development Notes

- Keep dependencies up to date (Dependabot is enabled).
- Avoid dynamic code execution (`eval`, `new Function`).
- Be careful with any future networking features; keep a strict "no upload" default.
