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
| `pnpm dev`, `build`, `build:ci`, `preview` | `scripts/build/run-vite.ts` launches package-local Vite; `prebuild` generates licenses and runs quality, while `build:ci` generates licenses, builds, then postprocesses without repeating quality. `dev`/`preview` start servers. | Reads source/core and installed Vite; builds write `dist/` and may update `public/LICENSES.md`. `scripts/check/run-child.test.ts`, `pnpm verify`, and artifact comparison check execution. |
| `pnpm postbuild`, `clean` | `scripts/build/postbuild.ts` finalizes distribution headers/assets; `scripts/build/clean.ts` removes generated output. | Inspect `dist/_headers`, output manifest and licenses after a build; `test/unit/config/node-script-boundaries.test.ts` checks direct CLI/import behavior. |
| `pnpm prepare:e2e:fixture`, `pretest:e2e:ci`, `pretest:e2e:resource`, `pretest:e2e:deploy` | `scripts/test/generate-e2e-video.ts` uses host FFmpeg/ffprobe; `scripts/test/prepare-resource-fixtures.ts` selects resource fixtures. | Writes ignored `public/test-video-*` files; requires codec tools on PATH. `test/unit/e2e-fixtures.test.ts`, child adapter tests, and affected E2E profile check outputs. |
| `pnpm test:e2e`, `test:e2e:ci`, `test:e2e:resource`, `test:e2e:deploy` | Plain `test:e2e` runs Playwright; `scripts/test/run-playwright.ts` selects the named CI, resource or deploy profile in the caller environment. | Requires built app/fixtures and browsers; writes test results/screenshots. `scripts/check/run-child.test.ts` covers argv, cwd, env, exit and signal; browser profiles have distinct scopes. |
| `pnpm verify:full` | Runs verify, coverage and `scripts/test/run-e2e-on-free-port.ts` CI smoke; chooses an ephemeral loopback port and invokes the package script via `npm_execpath`. | May bind loopback, generate fixtures, build, launch browsers and write reports; `test/unit/config/playwright-profile.test.ts` and CI smoke are checks. It is not all hardware/codec/Windows acceptance. |
| `pnpm test`, `test:watch`, `test:cov`, `test:ci` | Vitest and direct Node `scripts/ci/{deep-check-reuse,repository-authority}.test.ts`, `scripts/release/verify-source.test.ts` and `scripts/check/run-child.test.ts`. | Watch persists; coverage writes reports. `test:ci` checks reuse, repository authority, tagged source and portable child execution, not rendered conversion. |
| `pnpm check`, `check:test:unit`, `check:test:e2e`, `check:scripts`, `typecheck` | Browser, Vitest, Playwright and strict NodeNext/erasable TypeScript projects; `tsconfig.scripts.json` includes `scripts/**/*.ts` with ES2022 and Node types. Browser and Playwright projects retain their DOM and worker libraries. | Read-only; `pnpm quality` runs these boundaries. The Node boundary test compiles the full script project with positive Node and negative browser-global probes. Raw Windows `.mjs` is checked separately by that test. |
| `pnpm check:i18n` | `scripts/check/i18n.ts` compares locale JSON key sets. | Reads `src/i18n/*.json`; no writes; failure reports missing/extra keys. Run command plus i18n tests. |
| `pnpm fmt`, `fmt:check`, `lint`, `knip`, `knip:full`, `knip:production`, `circular` | Biome style/lint, entry/dependency and source-graph analysis. | Read-only; `knip.json` lists script project files and external FFmpeg/ffprobe. `fmt:fix`, `lint:fix`, `quality:fix` write fixes and require diff review. |
| `pnpm quality`, `verify` | Quality runs one read-only `biome ci .` pass for formatting, lint and import organization, then browser/unit/E2E/Node types, direct Node tests, i18n, graph/Knip. Verify adds production `build:ci`. | Verify generates build output and can update licenses; it excludes Vitest coverage and browser E2E. Inspect generated artifacts and affected tests. |
| `pnpm mut:prepare`, `mut`, `mut:fast` | Prepare an independent disposable checkout, then launch full/fast Stryker through `scripts/ci/mutation-workspace.ts`. Deep and Release admit their job-owned checkout; manual Deep runs default to fresh analysis. | One analysis per checkout; reports stay in `reports/mutation/`, diagnostics in `.git/wmc-mutation/`. See Mutation runs below. |
| `pnpm release:prepare` | `scripts/release/prepare.ts` creates a source/version-bound release bundle after verified build; `scripts/release/publication-guard.ts` with `legacy-state.ts` owns live publication order in release workflow. | Reads `RELEASE_VERSION`, optional source identity, built `dist`; writes release assets/metadata/checksums locally. `test/unit/config/{release-infrastructure,release-publication-guard,release-runtime}.test.ts` and artifact inspection. Preparation is not publication. |

### Mutation runs

Mutation testing uses Stryker's `inPlace` mode. Even `dryRunOnly` can write source
and temporary files during instrumentation. Run either profile in a separate,
independent full clone on Linux or WSL; native Windows invocation is refused.
Directly invoking the Stryker binary in a maintainer checkout bypasses this
protection and is unsafe. A run record helps prevent accidental use of the wrong
checkout; it is not an OS sandbox for hostile code.

Select a committed revision explicitly. The example creates a new directory
outside the source checkout; replace both absolute paths before running it.

```bash
MUTATION_SOURCE=/absolute/path/to/wasm-motion-converter
MUTATION_COMMIT=$(git -C "$MUTATION_SOURCE" rev-parse HEAD)
MUTATION_CLONE=/absolute/path/outside/source/wmc-mutation-1
git clone --no-local --no-hardlinks --no-checkout "$MUTATION_SOURCE" "$MUTATION_CLONE"
git -C "$MUTATION_CLONE" -c advice.detachedHead=false checkout --detach "$MUTATION_COMMIT"
git -C "$MUTATION_CLONE" submodule sync --recursive
git -C "$MUTATION_CLONE" submodule update --init --recursive
(
  cd "$MUTATION_CLONE"
  pnpm install --frozen-lockfile --package-import-method=copy
  pnpm mut:prepare "$MUTATION_SOURCE" "$MUTATION_COMMIT"
  pnpm mut:fast # or pnpm mut, using a new clone for the other profile
)
```

Uncommitted source or core edits are not included in the selected commit and
must not be described as tested. `pnpm mut` and `pnpm mut:fast` refuse an ordinary
maintainer checkout before instrumentation. Do not build, probe, or run another
agent in the disposable checkout during mutation. Deep and Release jobs use
their own job checkout directly, bound to the selected commit; they keep the
same canonical `pnpm mut:fast` report location and threshold.

Local diagnostic arguments are `--dryRunOnly`, `--concurrency`/`-c` (1–32),
`--logLevel`, `--mutate`/`-m`, and `--testFiles`/`-t`. Pass paths as relative
comma-separated globs within the clone. Diagnostic mutation patterns must select
existing regular files under `src/`;
test patterns must select existing `.test` or `.spec` files under `test/`.
Mutation positive patterns followed by exclusions must leave a nonempty
selection; Stryker mutation line ranges are supported. Test-file selectors
accept positive globs only, without mutation ranges or `!` exclusions. This
conservative admission check
prevents no-match fallback and is not Stryker discovery-equivalence evidence.
Other configuration and output path overrides are refused; hosted gates accept
no overrides. The full command keeps its progress display and also writes the
built-in JSON
report at `reports/mutation/mutation.json` so an empty or incomplete analysis
cannot be recorded as complete. The fast command keeps its configured reporters.
The boundary tests use Linux `unshare` for a private mount experiment when
available and report that case as skipped when the runner disables namespaces.

If a run fails or is interrupted, inspect `.git/wmc-mutation/`, reports, Stryker
backups, and the checkout's remaining processes before taking action. Preserve
logs and backups while deciding whether restoration completed. Compare any
modified content with its **before-run** state; `HEAD` cannot reconstruct dirty
before-run edits. A forced shutdown can prevent cleanup or final status writes.
Deep and Release attempt to retain available failure diagnostics for 14 days;
unconditional hosted cancellation can also prevent artifact upload.
Use a new disposable checkout for the next run, and discard the old one manually
only after confirming its ownership, process state, and retained evidence. Do
not reset or clean the maintainer checkout as a recovery step.

### Workflow and subprocess entrypoints

| Surface | Contract; stage and side effects | Verification / status |
| --- | --- | --- |
| `.github/workflows/ci.yaml`, `security.yaml` changed-path jobs | `scripts/ci/classify-workflow-changes.ts` uses the trusted base on PR/merge-group and protected checkout on push, reads Git event and NUL-safe no-renames diff, writes conservative fixed gate outputs. | `test/unit/config/workflow-routing.test.ts` exercises real temporary Git repositories; verify exact-SHA hosted gates run relevant jobs. |
| `.github/workflows/deep-checks.yaml` | Scheduled and manual runs always select mutation. `scripts/ci/deep-check-reuse.ts` owns bounded reuse with source, input, runner, and origin checks. | `scripts/ci/deep-check-reuse.test.ts` and `test/unit/config/mutation-profile.test.ts`; markers require a fresh successful gate and report upload. |
| `.github/workflows/security.yaml` pinned tools and OSV | `scripts/ci/pinned-tools.json` owns tool versions/digests; trusted private `pinned-tools.ts` and `check-pinned-tools.ts` provide image env and freshness checks. The independently pinned browser-core `automation/actions/prepare-osv` supplies the private `consumer` OSV helper; `packages/core` is the runtime gitlink. | `test/unit/config/pinned-tools-cli.test.ts`, `test/unit/config/osv-workflow-composition.test.ts`, and provider OSV fixtures; `docs/osv-workflow.md` explains trust order and live-container limits. |
| `.github/workflows/release.yaml` | `scripts/release/verify-source.ts` checks protected tagged source before validation fan-out; `prepare.ts` creates local files and `publication-guard.ts` plus `legacy-state.ts` own the locked public write decision. Short runner `run:` blocks select checkout, append outputs and launch actions. | `test/unit/config/{release-infrastructure,release-publication-guard,release-runtime}.test.ts`, `scripts/release/verify-source.test.ts` and artifact inspection. Preparation is not publication. |
| `.github/dependabot.yaml`, `update-browser-core.yaml` | Dependabot opens npm and GitHub Actions update PRs for maintainer review; repository workflows do not approve or merge dependency updates. `scripts/ci/update-browser-core.ts` verifies remote SHA/impact and owns gitlink PR preparation/publication. Runner shell passes event inputs and bounded output/checkout glue. | `test/unit/config/{dependency-review-policy,browser-core-automation}.test.ts` and `scripts/ci/repository-authority.test.ts`; hosted exact-SHA checks establish privileged results. |
| `.githooks/pre-commit`, `.githooks/pre-push` | Minimal Git-launched Bash guard rejects detached/default-branch commits and direct default-branch pushes before pinned Node setup. | `test/unit/config/git-hooks.test.ts`. Retain as a small pre-runtime Git adapter; revisit if the hook installer guarantees pinned Node for every local Git invocation without loosening the refusal. |
| Test subprocess callers | `test/unit/config/{command-adapters,workflow-routing,release-runtime,release-publication-guard,git-hooks,node-script-boundaries,playwright-profile}.test.ts`, `scripts/check/run-child.test.ts`, and `scripts/ci/repository-authority.test.ts` exercise CLI, child, Git, and release policy in fixtures. Provider tests own OSV parser/scanner behavior. | Keep callers and NodeNext configs aligned; fixture tests do not prove browser media or publication acceptance. |

CI and release cache Chromium, Firefox, and WebKit under an exact key containing
the installed Playwright version, runner OS/architecture, and Ubuntu 24.04.
Both workflows install browser and OS dependencies and run their E2E suite after
cache restoration. [Issue #324](https://github.com/PiesP/wasm-motion-converter/issues/324)
records the comparison behind this choice; revisit the cache when the runner
image, browser set, Playwright installation contract, or cache behavior changes.

### Windows bundle and retained languages

`validation/windows/profile.json` declares generated `dist`, named generated MP4/WebM fixtures, `output-contract.json` and raw `output-contract.mjs`; the controller imports `profile.mjs` and invokes `run({ browser, root, output })` under its pinned portable Windows Node and installed stable browser. The prepared Windows controller runs `pnpm prepare:e2e:fixture` and `pnpm build:ci` in a **clean Linux checkout**, then bundles `playwright-core` and portable Node. Guest Node/pnpm/FFmpeg on PATH are not prerequisites.

The raw `.mjs` is retained because the controller has no declared TS transpilation/loader or generated-JS stale-output contract; revisit only when one exists, all profile assets/imports are updated together, and focused prepared-VM validation succeeds. The Node boundary suite runs `node --check` over every `validation/windows/**/*.mjs` file; the E2E output-contract and resource-profile specs cover related behavior. This does not establish desktop, physical codec, GPU or media performance acceptance.

MP4 sample metadata uses the maintained MediaBunny patch and the limits in
`src/utils/constants.ts`. Its 32 MiB policy reserve completes the 128 MiB demux
envelope alongside source/packet and decoder-queue reserves. Scalar array entries
cost 16 policy bytes, timing/chunk records 96, presentation objects plus sorting
and inverse indices 128, and fragment samples plus presentation/sort data 304.
These conservative accounting units cover retained objects, spare array capacity
and overlapping index construction; they are not a measured browser heap bound.
Tables share a per-Input allocation budget. Unique fragment offsets also share a
cumulative work budget, while reparsing still reserves space alongside the prior
fragment. Repeated visits do not spend the unique-fragment quota again.

The separate 100,000,000 logical-sample ceiling bounds compact runs across tracks
without treating every implicit PCM audio frame as an allocated JavaScript
object. For comparison, 15 minutes at 48 kHz contains 43,200,000 PCM samples,
whereas 15 minutes at the supported 120 fps conversion clamp contains 108,000
video packets. Actual expanded tables remain constrained by the allocation
reserve. Malformed, inconsistent or over-budget metadata fails before expansion;
the caller disposes the input and the user can select another file. The focused
installed-parser tests use reduced budgets. The Windows profile checks bounded
production rejection and a subsequent GIF download in the same application
document; it does not run a destructive out-of-memory test.

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

The deploy dogfood JavaScript budget remains 150,000 bytes of positive
`PerformanceResourceTiming.transferSize` for resource URLs ending in `.js` on a
first navigation in a fresh Chromium context with service workers blocked. Its
test attaches per-resource transfer, encoded-body and decoded-body sizes and
fails if timing is empty or every transfer is zero. The [Resource Timing
specification](https://www.w3.org/TR/resource-timing/) defines transfer size
using the encoded body plus a fixed 300-byte header estimate for network loads;
local cache returns zero and validated cache returns 300. Compression changes
the encoded size, and cross-origin timing restrictions can conceal sizes. This
filter excludes other URL suffixes, including `.mjs` and `.wasm`, and resources
loaded only after an interaction; it is not a whole-page network-byte total.

## Production Pages deployment

The production path is the `master` source build in the existing `dropconvert`
Pages project, whose public subdomain is `wasm-motion-converter.pages.dev`.
Git integration, the production/preview controls, build image, install switch,
build cache and Web Analytics injection are provider settings; `wrangler.toml`
owns the Pages name, output directory, compatibility date and declared variables.
Keep previews disabled unless a separate change approves their intended layout.
The generated `release` branch has a different root layout and release cadence;
it is not the production source. A prebuilt migration requires a current,
source-bound artifact and a reviewed rollout, rather than reusing the historical
release merely because it exists.

The source-build settings are an empty repository root, output `dist`, build
command `node --experimental-strip-types scripts/build/pages-build.ts`, and
`SKIP_DEPENDENCY_INSTALL=1`. The dependency-free bootstrap validates effective
Node/pnpm against `.node-version` and `package.json`, restores and verifies the
recorded core gitlink, installs the frozen lockfile with build dependencies,
then runs `pnpm build`. Its quality, license and postbuild lifecycle stays a
deployment prerequisite. License notices omit build dates so CI and Pages can
reproduce the same public bytes across a date boundary. Read the provider log
for effective tools and core SHA. Declare `SKIP_DEPENDENCY_INSTALL = "1"` in
Wrangler `[vars]` as well as
the project settings: Pages projects using a Wrangler file read its variables
into the build environment before deciding whether to install dependencies.
Confirm the switch and the absence of an automatic install in the provider log.
Source watch paths remain inclusive: runtime, patches, gitlinks, headers and build inputs must
continue to trigger delivery. No custom-domain rules apply to the Pages-only
hostname; keep its built-in compression and CDN caching.

`postbuild` appends exact immutable rules only for emitted fingerprinted assets,
so a missing asset does not inherit a year-long cache rule. Document, worker
registration script and source metadata revalidate. A top-level `404.html`
prevents missing JavaScript/CSS/WASM URLs becoming successful SPA documents.
Static `_headers` supplies CSP and isolation without a global Pages Function;
check document, redirects, errors, both workers, WASM and offline recovery when
changing it. [RFC 9110 section 15.4.5](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.5)
requires a 304 response to include ETag when the corresponding 200 would include
it. Pages and local Wrangler omitted it in the historical observations in
[#289](https://github.com/PiesP/wasm-motion-converter/issues/289) and
[#292](https://github.com/PiesP/wasm-motion-converter/pull/292). The maintained
integration tolerates this provider compatibility exception and reports the
omission as nonconforming to that ETag requirement; it is not a general HTTP
allowance. Checks still require a usable 200 validator, a matching empty 304,
an unmatched 200 with identical bytes and ETag, and the security/cache policy
on every response. A present 304 ETag must match. Revisit this exception when
the provider/runtime changes or consistent compliant observations support
removing it; historical observations alone do not prove current behavior.
Pages Web Analytics injection is disabled at the project: build
processing cannot remove scripts injected later. The application does not ship
inline scripts or load external runtime code. Legacy provider CSP hashes are
retained until their original script is identified and removal is separately
validated; they do not authorize analytics or external script loading.

`deployment-state.json` records source/tree/core identity and hashes of the
postprocessed public distribution. It is separate from the tagged release's
`release-state.json`; a package version or 200 HTML fallback cannot identify
a deployment. After every successful `master` CI run, Production verification
downloads that exact run's build artifact, waits at most eight source checks
for Pages, compares the complete runtime inventory, and executes the maintained
deploy profile. It has read permissions and no production secrets. Superseded
sources fail explicitly as incomplete verification; unavailable expected metadata fails with a
provider pending/failed/skipped diagnostic instead of accepting old production.
The provider deployment ID, terminal result and source still need account
readback during a release/issue closeout.

For an authorized local public check, build the clean expected source and run:

```bash
pnpm prepare:e2e:fixture
EXPECTED_SOURCE_SHA="$(git rev-parse HEAD)" pnpm verify:deploy
```

Keep `SKIP_WEB_SERVER` unset. The deploy profile uses production controls and
checks runtime failures, asset types, worker/WASM conversion, downloads and the
unchanged cold JS transfer budget. Its output is ignored; preserve it externally
when used as acceptance evidence. Windows profile inputs and the task-owned
old-to-new cache/public scenarios are documented in
[Windows validation](./validation/windows/README.md).

Service-worker assets use one bounded app-owned cache across this update.
Previously cached entries are body-validated once during admission migration;
admitted hits need no fetch, clone, write or FIFO enumeration. A removed lazy
asset that was never cached cannot be reconstructed. Independently of worker
updates, a clean production build compiles its source SHA into the running app.
The app compares it with validated `/deployment-state.json` from its current
origin, including immutable deployments and local serving. SHAs are opaque
identities: a different build need not have a higher package version, and the
notice does not promise that every new asset is available offline. Development,
dirty and non-Git builds have unknown identity and do not check.

`observeDeploymentUpdates` checks at initial visible/online initialization,
when the tab becomes visible, on an online event while visible, and on BFCache
restoration. Attempts start at least 60 seconds apart with one request in flight
per owner. There is no polling or retry timer, so a continuously foreground tab
does not discover every deployment immediately. Each revalidating same-origin
request is limited to 10 seconds and 64 KiB, rejects redirects, non-200 or
non-JSON responses and invalid/dirty identity metadata. Offline, timeout and
unavailable responses remain unknown; a later eligible event may try again.
Owner cleanup aborts requests and ignores stale completion; BFCache retains
observation on return. Metadata is never used as the running app's first-fetch
baseline or persisted as another tab's identity.

The app offers an explicit reload after a different build, worker update or
failed asset, disables it during operations and while
a downloadable result remains, and asks users to download and clear the result
first. The notice provides an explicit **Clear result** action, disabled during
operations, so clearing a result allows reload without changing the selected
file or conversion settings. Changing the selected file alone retains the
result. A failed-asset warning takes precedence over an ordinary update notice.
Tabs loaded before this detector was deployed cannot acquire it without loading
the new app; they may show their original conversion error and need a
manual browser reload; updates never reload them automatically or delete their
result Blob.

### Long-lived tabs and prior build assets

The Pages source build serves the current generation and does not carry earlier
executable assets into `dist`. The app preserves recoverable in-memory results;
it does not guarantee that an old tab can load an asset it has never used.

| Situation | Support contract |
| --- | --- |
| Fresh navigation | Load the current document and its current asset graph. |
| Old open tab with loaded modules or a valid cached asset | Continue using available bytes. A worker update does not intentionally discard admitted asset entries, but cache storage is bounded. |
| Old open tab first requesting an asset after deployment | If its old URL is unavailable, show the asset failure and retain existing results and recovery actions. An update notice does not establish that old bytes still exist. |
| Offline cache hit, miss or eviction | A valid hit can work. A miss remains unavailable; neither the worker nor a longer HTTP cache lifetime can reconstruct missing bytes. Fully offline conversion is not guaranteed. |
| Expiry, emergency withdrawal or authorized rollback | An absent asset path must remain a genuine, non-immutable 404 at the origin, without substituting current code under an old URL. Withdrawal and rollback need separate review and do not promise to restore old assets. |

The recovery actions above require the application shell to have loaded. An
entry or static-module failure before it initializes remains outside that
boundary. For a recoverable failure, download any retained result, explicitly
clear it, then choose reload; an active operation must first finish or be safely
cancelled. The app never reloads or discards a result automatically. A failed
asset alone does not prove that a deployment occurred; the update notice uses
validated deployment metadata for that determination.

The measured fixed-recovery A/B comparison used source builds
`63707a7b404c7ef411a8a94ebd24d75536c5bf00` and
`3a40e006b1c6ab7e7beab361d73bc4aecaa8a7bb`. Retaining the earlier
generation's complete asset set in the latter build would add eight files
(708,328 decoded bytes), eight exact asset-header rules and at least 1,278
metadata bytes before recording prior-source provenance. Distribution size
would grow from 1,743,326 to 2,453,578 bytes, about 40.7%. These additions
fit the current file, header and metadata limits; retention is technically
possible. It would also require approved immutable prior-build inputs supplied
identically to CI and the Pages source build, final-byte provenance, collision
rejection, pruning and a withdrawal procedure. The selected policy is explicit
recovery without cross-deployment asset retention. Revisit it if measured need
and an approved delivery contract justify that work. This comparison did not
compose or deploy retained assets.

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

Each new release-branch artifact contains `release-state.json` with the version and verified
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
- Keep essential error, warning, and recovery UI eager: after application
  initialization, its first usable render must not require another network
  request. Keep heavy conversion code lazy. A feature boundary must preserve
  cancellation, diagnostics, existing result downloads, and explicit guarded
  reload outside the failing presentation subtree.

## Code style

- English is canonical for source, comments, documentation, and commit
  messages. The supported translated documentation is limited to the root
  `README.ko.md` and `README.ja.md`, which must keep the same product, privacy,
  support, and warning meaning as `README.md`.
- Keep diffs small and focused; keep loading/progress/error states intact.
- Provide explicit user feedback for long-running actions.

### Formatting and inspection scope

Biome is the single formatter, import organizer, and linter. Use 2-space
indentation, a 100-column target, LF, single quotes, semicolons, and ES5 trailing
commas (no trailing comma in function arguments). `quality` runs one read-only
`biome ci .` pass before the existing type, native-test, i18n, graph, and Knip
gates. Use the existing `fmt:fix`, `lint:fix`, or `quality:fix` commands for
repairs; separate mechanical changes from behavior-relevant edits.

`biome.json` includes maintained browser source, Node scripts, tests and helpers,
Vite tooling, raw Windows validation modules and contracts, the release-runtime
action module, root TypeScript/JSON/HTML configuration, the service worker, the
404 page, and bundled dependency metadata. Git ignore rules remain effective.
The shared `packages/core` checkout, dependencies, generated distributions and
reports, lockfiles, media, binary snapshots, patches, and generated Windows
inputs/prior distributions/public targets are outside this inspection scope.
Fixture strings embedded in test code are still checked as code; their literal
values and intentionally malformed subjects must remain unchanged. Do not
exclude ordinary test/helper code to avoid diagnostics.

### Modules and TypeScript contracts

- In browser `src/**`, use alias-based leaf imports across folders. Same-folder
  relative imports and package subpaths are allowed. Biome's built-in
  `noRestrictedImports` rejects parent-relative imports, `src/` and `/src/`
  absolute module paths, and child-folder relative imports. This covers static
  imports, type imports, applicable re-exports, and literal dynamic imports.
  Keep dynamic fallback, development-only, and lazy component loads dynamic.
- Do not add barrel imports. Whether an alias names a leaf or an intentional
  public compatibility export is a review responsibility: the restriction rule
  matches specifiers, not the resolved module graph. Computed module specifiers
  and CommonJS `require()` also require review: the locked rule does not diagnose
  these controls. `new URL('./worker.ts', import.meta.url)` and asset URLs
  are resource contracts, outside module-import restrictions.
- Node-executed scripts retain relative imports with explicit runtime file
  extensions, NodeNext resolution, and type-stripping-compatible syntax. Raw
  Windows `.mjs` and the small Git-hook Bash adapters keep their documented
  execution exceptions. Browser aliases do not apply to these entrypoints.
- Prefer named exports for ordinary functions and types. Preserve component
  defaults required by lazy loading. Use PascalCase component names and
  kebab-case ordinary module filenames for new/touched code; avoid mass renames.
- Keep strict TypeScript, including `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. Prefer named domain
  contracts at module boundaries, local inference inside implementations, and
  `satisfies` at object construction. Avoid assertion chains between compatible
  types; legitimate `as const`, `Parameters`, `ReturnType`, and documented
  platform adapters remain useful.
- Model absent optional properties, explicit `undefined`, and `null` according
  to their contract. Do not mechanically remove `| undefined` from optional
  properties under `exactOptionalPropertyTypes`.

### Reactivity, ownership, and diagnostics

- Keep Solid props reactive through property access, accessors, or `splitProps`.
  Separate derived values from effects and owner-scoped cleanup. The React
  dependency-array rule `useExhaustiveDependencies` is disabled for Solid
  source; it does not verify Solid reactivity.
- Prefer immutable request/configuration boundaries. Owned mutable buffers,
  queues, counters, loops, and resource-holding classes are appropriate in media
  hot paths. Do not add copies merely to satisfy a style preference.
- Intentionally unawaited work needs an explicit rejection and cleanup owner;
  `void promise` alone does not handle rejection. Preserve meaningful awaits,
  microtasks, ordering, and backpressure boundaries.
- Use unit-bearing names for new time/size values. English comments should
  explain ownership, units, ordering, or platform constraints. Preserve
  serialized protocol names unless making an explicit compatibility change.
- Fix applicable diagnostics without weakening correctness, accessibility,
  explicit-any, unused-import, or accumulation-spread checks. Retain narrowly
  explained exceptions for literal GitHub Actions assertions, inert native
  mocks, asynchronous receiver capture, and cleanup failures raised only when
  there is no primary failure. Do not apply unsafe automatic fixes, broad
  suppressions, automatic async rewrites, or new global warning policies.

The installed Biome boundary tests use disposable valid/invalid controls to
check actual scope, VCS ignores, import restrictions, read-only behavior, and
fix convergence. Relevant references are [Biome import restrictions](https://biomejs.dev/linter/rules/no-restricted-imports/javascript/),
[the React dependency rule](https://biomejs.dev/linter/rules/use-exhaustive-dependencies/javascript/),
[Node TypeScript execution](https://nodejs.org/api/typescript.html), and
[Solid props](https://docs.solidjs.com/concepts/components/props).

## Dependency update policy

- Prefer current stable libraries and tools; this project intentionally adopts
  modern platform and ecosystem capabilities quickly.
- pnpm and Dependabot enforce a 24-hour cooling window for newly published
  packages. Do not bypass it for routine updates.
- Dependabot creates grouped npm and GitHub Action updates on the configured
  schedule. Every dependency update requires explicit maintainer review,
  including patch/minor, major and security updates; no auto-eligible category
  remains. An open security alert prioritizes review and never authorizes it.
- `package.json`, `pnpm-workspace.yaml`, and pinned workflow digests are the
  authoritative versions. Run `pnpm verify:full` after substantive upgrades.

Review the exact dependency/Action diff and its upstream source, release notes,
security advisory and changed executable/install behavior. Verify the selected
version or immutable Action SHA, frozen-lock installation and applicable CI at
the current PR head, then use the ordinary protected merge path. Re-review if
that head changes; never bypass protection or cooling/trust controls. Security
updates follow the same admission boundary with higher review priority.
Dependabot opens the update PR and requests PiesP's review; the ordinary CI and
security checks run on that PR before its protected merge.

The browser-core updater computes impact and previews publication in a read-only
job. A separate writer checks out trusted current source, installs no project
dependencies, reprepares the update and requires the classified base/target to
match before publishing only the gitlink PR. Its pinned runtime setup and
publication code still require maintainer trust. Release build/test jobs remain
read-only; existing protected-source, integrity and locked publication checks
remain required. Manual review, pins, checksums and attestations do not prove
that an upstream compiler, Action or resulting build is free of malicious code.

## License

By contributing, you agree that your changes are licensed under the
[project license](./LICENSE).

Duplication is reviewed in context. Consolidate code only when responsibility, lifecycle, and reasons for change are compatible.
