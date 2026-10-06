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

### Command ownership: install and local duplication check

| Public command | Purpose and implementation | Runtime and prerequisites | Inputs, outputs, and side effects | Verification |
| --- | --- | --- | --- | --- |
| `pnpm install` → `preinstall` | Check `packages/core/package.json` in `scripts/check/bootstrap.ts` before dependency installation. | Manifest-supported Node with built-in TypeScript stripping; no `node_modules` or initialized submodule required to run the check. | Reads the shared-core package path; exits with an actionable submodule command if it is missing. It does not write files. | `test/unit/config/command-adapters.test.ts`; `pnpm check:scripts` |
| `pnpm quality:nose` (also called by `pnpm quality`) | Run the local duplication query from `scripts/check/nose.ts`. | Manifest-supported Node and optional externally installed Nose. | Inherits the environment and project working directory; reads `src` and `.nose-baseline.json`, and forwards Nose output/status/signal. The adapter itself writes no project files. Only a missing Nose binary skips locally. | `test/unit/config/command-adapters.test.ts`; `pnpm quality` |

Both adapters are import-inert TypeScript commands. The Nose executable is an
external tool; required CI installation and integrity checks are owned by
`scripts/ci/install-nose.sh` and the workflows, where failure remains fatal.
Revisit the external-tool exception if Nose gains a repository-local Node API
that preserves its pinned installer and CI integrity contract.

## Validation

### Workflow change classifier

`scripts/ci/classify-workflow-changes.ts` owns the CI and security changed-path
policy. The `changes` jobs in `.github/workflows/ci.yaml` and
`.github/workflows/security.yaml` run it with built-in Node TypeScript stripping
after setting up the manifest-pinned Node runtime without project dependencies.
For pull requests and merge groups, each job extracts the classifier from its
trusted base commit before running it; a missing trusted file or failed routing
enables every gate. This also covers the first migration PR. Pushes and manual
or scheduled runs use the checked-out protected revision. The classifier reads
the GitHub event JSON and a direct `git diff --no-renames --name-only -z` between
the event's two commits, then writes fixed Boolean outputs to `GITHUB_OUTPUT`.
It creates no repository files. `pnpm test test/unit/config/workflow-routing.test.ts`
checks real Git boundaries and path routing; `pnpm check:scripts` checks its
NodeNext types. Review this trusted-source rule when the workflow event model
or classifier path changes.

Run the narrowest relevant test while working. Before opening a pull request, run:

```bash
pnpm verify
pnpm test
```

Use `pnpm verify:full` for substantive or publication-level changes. Browser
behavior changes also require the relevant Playwright flow. See the
[testing guide](./test/README.md) for profiles and fixtures.

## Release publication order

The manual release workflow accepts a verified `vX.Y.Z` tag from protected
`master`. Its validation and build jobs can run concurrently. The `publish` job
has one lock shared by all tags; after it obtains the lock, it checks the live
tag, public releases, Latest, and the `release` branch before either write.
Ordinary historical publication and deployment rollback are rejected. New
stable releases explicitly become Latest. A retry of the same version and source
skips writes already completed. A published release is accepted only after
verifying the uploaded archive, `metadata.json`, and `checksums.txt`, including
their sizes, digests, and the two checksum entries. Incomplete or unverifiable
published assets stop the retry and require maintainer review. The workflow
never replaces existing release assets or retargets tags. An intentional rollback
needs a separate reviewed procedure.

Each new deployment contains `release-state.json` with the version and verified
tagged commit. The downloadable `metadata.json` records that same identity.
For the existing branch without `release-state.json`, the guard verifies the
Latest release's metadata and live tag, checks the published archive digest,
then compares every archived file byte-for-byte with the branch tree. The Pages
action's empty `.nojekyll` file is the only allowed extra file. A mismatch,
missing archive, oversized or unsafe archive, or incomplete API response stops
publication; a separately reviewed bootstrap is then required. Latest alone
never establishes branch identity. After the first guarded deployment writes a
marker, that marker becomes the branch identity for subsequent runs.

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
