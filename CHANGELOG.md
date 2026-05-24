# Changelog

All notable changes to **WASM Motion Converter** are documented in this file.

The format follows the principles of
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the project
roughly adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Video motion conversion**: Convert video files using WebCodecs and ffmpeg.wasm with 100% client-side processing.
- **Solid.js UI**: Reactive frontend built with Solid.js, TypeScript.
- **Service Worker**: Offline-capable PWA with CDN dependency integrity verification.
- **CI pipeline**: Automated quality gate (format, lint, typecheck, build, SRI generation) on push/PR.

### Changed

- **Infrastructure**: Migrated to pnpm 11.2.2, Node.js 24.x, TypeScript 6.x, Biome 2.x, Vite 8.x.
- **Security**: Pinned all GitHub Actions to commit SHAs, added Dependabot with auto-merge.
