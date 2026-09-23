# Contributing

Thanks for improving **dropconvert**.

## Communication

- Questions and troubleshooting: [SUPPORT.md](./SUPPORT.md)
- Bugs and feature requests: [GitHub Issues](https://github.com/PiesP/wasm-motion-converter/issues)
- Security and privacy reports: [.github/SECURITY.md](./.github/SECURITY.md)

## Before opening an issue

- Read [README.md](./README.md) and [SUPPORT.md](./SUPPORT.md)
- Check existing issues

### Bug reports: include diagnostics

- The WebCodecs or input-codec error shown by the application
- Relevant browser console errors
- Browser + version
- OS + device type
- Expected vs. actual behavior
- Exact repro steps
- Input video details (format, codec, resolution, file size)

Avoid attaching sensitive or private files.

## Development setup

Use the toolchain pinned in `package.json`, or versions that satisfy its
`engines` fields. Then initialize the shared submodule and install dependencies:

```bash
git submodule update --init --recursive
pnpm install
```

```bash
pnpm dev
```

COOP/COEP headers are configured in `vite.config.ts` for development and preview.

## Validation

Run the narrowest relevant test while working. Before opening a pull request, run:

```bash
pnpm verify
pnpm test
```

Use `pnpm verify:full` for substantive or publication-level changes. Browser
behavior changes also require the relevant Playwright flow. See the
[testing guide](./test/README.md) for profiles and fixtures.

## Project constraints

- Keep media processing in the browser; do not add server uploads.
- Preserve the COOP/COEP security boundary and `SharedArrayBuffer`
  availability. The current single-threaded encoders do not require either
  cross-origin isolation or `SharedArrayBuffer`.
- Bundle runtime code locally; do not add runtime CDN dependencies.
- Keep progress, cancellation, error, and cleanup behavior explicit.

## Code style

- English is canonical for source, comments, documentation, and commit
  messages. The supported translated documentation is limited to the root
  `README.ko.md` and `README.ja.md`, which must keep the same product, privacy,
  support, and warning meaning as `README.md`.
- Keep diffs small and focused; keep loading/progress/error states intact.
- Provide explicit user feedback for long-running actions.
- Use alias-based, leaf imports for cross-folder modules.
- No barrel imports.
- Same-folder relative imports are allowed; do not use parent-relative imports
  across folders or `src/` absolute paths.

## Dependency update policy

- Prefer current stable libraries and tools; this project intentionally adopts
  modern platform and ecosystem capabilities quickly.
- pnpm and Dependabot enforce a 24-hour cooling window for newly published
  packages. Do not bypass it for routine updates.
- Dependabot checks npm packages and GitHub Actions daily. Passing patch/minor
  updates from the reviewed tooling allowlist may auto-merge; majors and runtime
  behavior changes require manual review.
- `package.json`, `pnpm-workspace.yaml`, and pinned workflow digests are the
  authoritative versions. Run `pnpm verify:full` after substantive upgrades.

## License

By contributing, you agree that your changes are licensed under the
[project license](./LICENSE).
