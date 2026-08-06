# Changelog

All notable changes to **WASM Motion Converter** are documented in this file.

The format follows the principles of
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the project
roughly adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-08-06

### Fixed

- **Release bundle integrity** — Packaged the deployable app tree as a single archive so GitHub Release downloads preserve asset paths and pass standard checksum verification.

## [0.2.0] - 2026-08-06

### Added

- **Preview timeline trimming** — Added an interactive video timeline with precise seeking, keyboard-accessible handles, validated trim ranges, and persistent editor state.
- **Adaptive conversion safeguards** — Added resource-aware frame decimation, conversion profiling, hostile-input fixtures, and browser resource tests for demanding GIF and WebP workloads.

### Changed

- **Conversion pipeline** — Streamed demuxed chunks into the decoder, bounded resource-heavy presets, and aligned adaptive behavior across primary and fallback encoders.
- **Interface and accessibility** — Adopted the shared Quiet Instruments design foundation and expanded automated accessibility, responsive layout, localization, and interaction coverage.
- **Shared runtime** — Updated browser-core and consolidated shared async, locale, error, logging, and utility behavior.
- **Release verification** — Expanded quality, coverage, browser, duplication, mutation, security, artifact, and deployment gates.

### Fixed

- **Memory and resource lifecycle** — Bounded cumulative encoded-chunk memory and released decoder, frame, buffer, canvas, and Worker resources on success, cancellation, fallback, and failure paths.
- **Conversion correctness** — Preserved frame timing, presentation order, trim boundaries, progress, output ownership, and adaptive decimation across GIF and WebP pipelines.
- **Input and protocol hardening** — Strengthened media validation, Worker message contracts, cancellation ownership, and malformed-input handling while preserving fully local processing.
- **Cloudflare build consistency** — Aligned the Pages build runtime with the repository Node.js pin and made complete security scans mandatory after changes land on `master`.

## [0.1.5] - 2026-07-19

### Fixed

- **Mutation gate**: Added edge-path coverage for validation, memory, state, DOM, logging, and output handling; configured Stryker per-test coverage with static mutants excluded for bounded CI runtime.

## [0.1.4] - 2026-07-19

### Fixed

- **Mutation gate**: Pinned TypeScript 6.0.3, restoring the TypeScript API required by Stryker 9.6.1.

## [0.1.3] - 2026-07-19

### Fixed

- **Mutation gate**: Updated the Stryker command for the installed 9.6.1 CLI and disabled in-place mutation to keep CI worktrees clean.

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
