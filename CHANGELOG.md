# Changelog

All notable changes to **WASM Motion Converter** are documented in this file.

The format follows the principles of
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the project
roughly adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-07-19

### Fixed

- **CI/CD**: Restored valid workflow metadata so GitHub Actions executes release and verification jobs.

## [0.1.1] - 2026-07-19

### Added

- **Video motion conversion**: Convert video files to GIF/WebP using WebCodecs with 100% client-side processing.
- **Solid.js UI**: Reactive frontend built with Solid.js, TypeScript.
- **Service Worker**: Offline-capable PWA with CDN dependency integrity verification.
- **CI pipeline**: Automated quality gate (format, lint, typecheck, build, SRI generation) on push/PR.

### Changed

- **Infrastructure**: Migrated to pnpm 11.2.2, Node.js 24.x, TypeScript 6.x, Biome 2.x, Vite 8.x.
- **Security**: Pinned all GitHub Actions to commit SHAs, added Dependabot with auto-merge.
- **Reliability**: Hardened frame-buffer bounds, worker failure handling, cancellation cleanup, and GIF palette-buffer ownership.
- **Memory safety**: Added conservative worker memory guards and surfaced conversion memory telemetry in the progress UI.
- **Progress**: Ensured terminal 100% progress is delivered even when throttling is active.
- **Maintenance**: Removed unreachable decoder/i18n/component entry points and unused exports identified by the audit.
