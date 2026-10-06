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

## Command catalog

Run package commands from the repository root with manifest-pinned Node and
pnpm after restoring the recorded `packages/core` gitlink. The dependency-free
`preinstall` check can run before dependencies exist. `packages/core` supplies
product runtime code; automation helpers are consumer-owned or separately
pinned. The table records execution stage, inputs, side effects and checks.

### Package commands

| Public command or family | Purpose; owner, runtime, and stage | Inputs, outputs, side effects; verification |
| --- | --- | --- |
| `pnpm install` (`preinstall`) | Dependency-free `scripts/check/bootstrap.ts` checks the core manifest before `node_modules` exists. | Reads `packages/core/package.json`, prints actionable initialization steps and fails if absent; no check writes. `test/unit/config/command-adapters.test.ts`, `pnpm check:scripts`; the package-manager install is separate. |
| `pnpm quality:nose` | Optional local duplication query in `scripts/check/nose.ts`; Nose is an external installed binary. | Reads `src` and `.nose-baseline.json`; inherits cwd/environment and forwards status/signal, skipping only missing binary. `test/unit/config/command-adapters.test.ts`; required CI install/check never skips. |
| `pnpm dev`, `build`, `build:ci`, `analyze`, `preview` | `scripts/build/run-vite.ts` launches package-local Vite; `prebuild` generates licenses and runs quality, while `build:ci` generates licenses, builds, then postprocesses without repeating quality. `dev`/`preview` start servers. | Reads source/core and installed Vite; builds write `dist/` and may update `public/LICENSES.md`, analyze writes stats. `scripts/check/run-child.test.ts`, `pnpm verify`, and artifact comparison check execution. |
| `pnpm postbuild`, `clean` | `scripts/build/postbuild.ts` finalizes distribution headers/assets; `scripts/build/clean.ts` removes generated output. | Inspect `dist/_headers`, output manifest and licenses after a build; `test/unit/config/node-script-boundaries.test.ts` checks direct CLI/import behavior. |
| `pnpm prepare:e2e:fixture`, `pretest:e2e:ci`, `pretest:e2e:resource`, `pretest:e2e:deploy` | `scripts/test/generate-e2e-video.ts` uses host FFmpeg/ffprobe; `scripts/test/prepare-resource-fixtures.ts` selects resource fixtures. | Writes ignored `public/test-video-*` files; requires codec tools on PATH. `test/unit/e2e-fixtures.test.ts`, child adapter tests, and affected E2E profile check outputs. |
| `pnpm test:e2e`, `test:e2e:ci`, `test:e2e:resource`, `test:e2e:deploy` | Plain `test:e2e` runs Playwright; `scripts/test/run-playwright.ts` selects the named CI, resource or deploy profile in the caller environment. | Requires built app/fixtures and browsers; writes test results/screenshots. `scripts/check/run-child.test.ts` covers argv, cwd, env, exit and signal; browser profiles have distinct scopes. |
| `pnpm verify:full` | Runs verify, coverage and `scripts/test/run-e2e-on-free-port.ts` CI smoke; chooses an ephemeral loopback port and invokes the package script via `npm_execpath`. | May bind loopback, generate fixtures, build, launch browsers and write reports; `test/unit/config/playwright-profile.test.ts` and CI smoke are checks. It is not all hardware/codec/Windows acceptance. |
| `pnpm test`, `test:watch`, `test:cov`, `test:ci` | Vitest and direct Node `scripts/ci/{deep-check-reuse,repository-authority}.test.ts`, `scripts/release/verify-source.test.ts` and `scripts/check/run-child.test.ts`. | Watch persists; coverage writes reports. `test:ci` checks reuse, repository authority, tagged source and portable child execution, not rendered conversion. |
| `pnpm check`, `check:test:unit`, `check:test:e2e`, `check:scripts`, `typecheck` | Browser, Vitest, Playwright and strict NodeNext/erasable TypeScript projects; `tsconfig.scripts.json` includes `scripts/**/*.ts` with ES2022 and Node types. Browser and Playwright projects retain their DOM and worker libraries. | Read-only; `pnpm quality` runs these boundaries. The Node boundary test compiles the full script project with positive Node and negative browser-global probes. Raw Windows `.mjs` is checked separately by that test. |
| `pnpm check:i18n` | `scripts/check/i18n.ts` compares locale JSON key sets. | Reads `src/i18n/*.json`; no writes; failure reports missing/extra keys. Run command plus i18n tests. |
| `pnpm fmt`, `fmt:check`, `lint`, `knip`, `knip:full`, `knip:production`, `circular` | Biome style/lint, entry/dependency and source-graph analysis. | Read-only; `knip.json` lists script project files and external FFmpeg/ffprobe/Nose. `fmt:fix`, `lint:fix`, `quality:fix` write fixes and require diff review. |
| `pnpm quality`, `verify` | Quality chains style, browser/unit/E2E/Node types, direct Node tests, i18n, graph/Knip and optional Nose. Verify adds production `build:ci`. | Verify generates build output and can update licenses; it excludes Vitest coverage and browser E2E. Inspect generated artifacts and affected tests. |
| `pnpm mut`, `mut:fast` | Stryker full/fast mutation gates. | Generates temp/reports; use actual mutation receipts. |
| `pnpm release:prepare` | `scripts/release/prepare.ts` creates a source/version-bound release bundle after verified build; `scripts/release/publication-guard.ts` with `legacy-state.ts` owns live publication order in release workflow. | Reads `RELEASE_VERSION`, optional source identity, built `dist`; writes release assets/metadata/checksums locally. `test/unit/config/{release-infrastructure,release-publication-guard,release-runtime}.test.ts` and artifact inspection. Preparation is not publication. |

### Workflow and subprocess entrypoints

| Surface | Contract; stage and side effects | Verification / status |
| --- | --- | --- |
| `.github/workflows/ci.yaml`, `security.yaml` changed-path jobs | `scripts/ci/classify-workflow-changes.ts` uses the trusted base on PR/merge-group and protected checkout on push, reads Git event and NUL-safe no-renames diff, writes conservative fixed gate outputs. | `test/unit/config/workflow-routing.test.ts` exercises real temporary Git repositories; verify exact-SHA hosted gates run relevant jobs. |
| `.github/workflows/deep-checks.yaml` | `scripts/ci/deep-check-reuse.ts` owns bounded duplication/mutation reuse. The workflow copies `scripts/ci/{pinned-tools.json,pinned-tools.ts,install-nose.ts}` from the reviewed tool revision before required Nose installation. | `scripts/ci/deep-check-reuse.test.ts` and `test/unit/config/pinned-tools-cli.test.ts`; installer digest/network failure remains fatal. |
| `.github/workflows/security.yaml` pinned tools and OSV | `scripts/ci/pinned-tools.json` owns tool versions/digests; trusted private `pinned-tools.ts` and `check-pinned-tools.ts` provide image env and freshness checks. The independently pinned browser-core `automation/actions/prepare-osv` supplies the private `consumer` OSV helper; `packages/core` is the runtime gitlink. | `test/unit/config/pinned-tools-cli.test.ts`, `test/unit/config/osv-workflow-composition.test.ts`, and provider OSV fixtures; `docs/osv-workflow.md` explains trust order and live-container limits. |
| `.github/workflows/release.yaml` | `scripts/release/verify-source.ts` checks protected tagged source before validation fan-out; `prepare.ts` creates local files and `publication-guard.ts` plus `legacy-state.ts` own the locked public write decision. Short runner `run:` blocks select checkout, append outputs and launch actions. | `test/unit/config/{release-infrastructure,release-publication-guard,release-runtime}.test.ts`, `scripts/release/verify-source.test.ts` and artifact inspection. Preparation is not publication. |
| `.github/workflows/dependabot-auto-merge*.yaml`, `update-browser-core.yaml` | Dependabot gate artifact precedes `scripts/ci/dependabot-apply.ts` validation and exact PR/commit rechecks before approval/merge. `scripts/ci/update-browser-core.ts` verifies remote SHA/impact and owns gitlink PR preparation/publication. Runner shell passes event inputs and bounded output/checkout glue. | `test/unit/config/{dependabot-auto-merge,browser-core-automation}.test.ts` and `scripts/ci/repository-authority.test.ts`; hosted exact-SHA checks establish privileged results. |
| `.githooks/pre-commit`, `.githooks/pre-push` | Minimal Git-launched Bash guard rejects detached/default-branch commits and direct default-branch pushes before pinned Node setup. | `test/unit/config/git-hooks.test.ts`. Retain as a small pre-runtime Git adapter; revisit if the hook installer guarantees pinned Node for every local Git invocation without loosening the refusal. |
| Test subprocess callers | `test/unit/config/{command-adapters,workflow-routing,release-runtime,release-publication-guard,git-hooks,node-script-boundaries,playwright-profile}.test.ts`, `scripts/check/run-child.test.ts`, and `scripts/ci/repository-authority.test.ts` exercise CLI, child, Git, and release policy in fixtures. Provider tests own OSV parser/scanner behavior. | Keep callers and NodeNext configs aligned; fixture tests do not prove browser media or publication acceptance. |

### Windows bundle and retained languages

`validation/windows/profile.json` declares generated `dist`, named generated MP4/WebM fixtures, `output-contract.json` and raw `output-contract.mjs`; the controller imports `profile.mjs` and invokes `run({ browser, root, output })` under its pinned portable Windows Node and installed stable browser. The prepared Windows controller runs `pnpm prepare:e2e:fixture` and `pnpm build:ci` in a **clean Linux checkout**, then bundles `playwright-core` and portable Node. Guest Node/pnpm/FFmpeg on PATH are not prerequisites.

The raw `.mjs` is retained because the controller has no declared TS transpilation/loader or generated-JS stale-output contract; revisit only when one exists, all profile assets/imports are updated together, and focused prepared-VM validation succeeds. The Node boundary suite runs `node --check` over every `validation/windows/**/*.mjs` file; the E2E output-contract and resource-profile specs cover related behavior. This does not establish desktop, physical codec, GPU or media performance acceptance.

Small workflow shell blocks remain runner bootstrap, checkout, output, and action-launch adapters; revisit them when tested Node entrypoints preserve trusted-source and write ordering. The Git hooks remain Bash because Git invokes them before pinned Node setup.

## Validation

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
