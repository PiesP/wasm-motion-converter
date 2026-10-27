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
npm install --global "$(node -p "require('./package.json').packageManager")" --allow-scripts=pnpm
pnpm install --frozen-lockfile
```

Volta selects Node.js; `packageManager` selects native pnpm. Follow the
[shared bootstrap](https://github.com/PiesP/browser-core/blob/master/README.md#development)
when retiring an existing global Volta pnpm selection; PATH order alone does not
prevent Volta's Node launcher from selecting that obsolete manager.

```bash
pnpm dev
```

COOP/COEP headers are configured in `vite.config.ts` for development and preview.

## Dependency and action updates

Dependabot manages workflow dependencies and the external actions inside
`.github/actions/setup-release`. CodeQL, `pnpm/action-setup`, and other Actions use
separate update groups so a toolchain contract failure does not block unrelated
scanner maintenance. Updates remain subject to maintainer review and the
existing minimum 24-hour release age.

The local release action resolves the tagged manifest pin, selects that Node,
then installs the manifest-pinned pnpm before the frozen dependency install. It disables
automatic package-manager caching and installation in both setup actions.

Every workflow action job first invokes the [browser-core Node trust preparation](https://github.com/PiesP/browser-core/blob/381b4ca733494cf069212cd0d16458389a83c623/automation/README.md#consumer-contract) at that reviewed SHA, with OpenSSL trust settings inherited by action bootstrap and post steps. The helper supports Ubuntu 24.04 and Alpine 3.23; unsupported systems fail before later actions. Its step boundary does not cover runner downloads or container pulls that happen before steps.

For an action update, verify the full commit SHA against the official upstream
release and update the independent allowed-SHA expectations in
`test/unit/config/toolchain-action.test.ts` in the same reviewed change. Keep
the protected checkout, verified runtime, action inputs, cache behavior, locked
installation, and publication boundaries intact. Do not make the expected SHA
follow the workflow being tested. Local release recipes retain their separately
reviewed compatibility contracts.

Run the focused toolchain and dependency-policy tests, then `pnpm verify` and
the applicable workflow checks. Preserve failed evidence and distinguish a
reviewed pin-contract update from a runtime failure before splitting or closing
an update PR. A setup check does not authorize release publication.

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
| `pnpm dev`, `build`, `build:ci`, `preview` | `scripts/build/run-vite.ts` launches project-local Vite+; `prebuild` generates licenses and runs quality, while `build:ci` generates licenses, builds, then postprocesses without repeating quality. `dev`/`preview` start servers. | Reads source/core and installed Vite+; builds write `dist/` and may update `public/LICENSES.md`. `scripts/check/run-child.test.ts`, `pnpm verify`, and artifact comparison check execution. |
| `pnpm postbuild`, `clean` | `scripts/build/postbuild.ts` finalizes distribution headers/assets; `scripts/build/clean.ts` removes generated output. | Inspect `dist/_headers`, output manifest and licenses after a build; `test/unit/config/node-script-boundaries.test.ts` checks direct CLI/import behavior. |
| `pnpm prepare:e2e:fixture`, `pretest:e2e:ci`, `pretest:e2e:resource`, `pretest:e2e:deploy` | `scripts/test/generate-e2e-video.ts` uses host FFmpeg/ffprobe; `scripts/test/prepare-resource-fixtures.ts` selects resource fixtures. | Writes ignored `public/test-video-*` files; requires codec tools on PATH. `test/unit/e2e-fixtures.test.ts`, child adapter tests, and affected E2E profile check outputs. |
| `pnpm test:e2e`, `test:e2e:ci`, `test:e2e:resource`, `test:e2e:deploy` | Plain `test:e2e` runs Playwright; `scripts/test/run-playwright.ts` selects the named CI, resource or deploy profile in the caller environment. | Requires built app/fixtures and browsers; writes test results/screenshots. `scripts/check/run-child.test.ts` covers argv, cwd, env, exit and signal; browser profiles have distinct scopes. |
| `pnpm verify:full` | Runs verify, coverage and `scripts/test/run-e2e-on-free-port.ts` CI smoke; chooses an ephemeral loopback port and invokes the package script via the pinned native `npm_execpath`. | May bind loopback, generate fixtures, build, launch browsers and write reports; `test/unit/config/playwright-profile.test.ts` and CI smoke are checks. It is not all hardware/codec/Windows acceptance. |
| `pnpm test`, `test:watch`, `test:cov`, `test:ci` | Vite+ Vitest and direct Node `scripts/ci/repository-authority.test.ts`, `scripts/release/verify-source.test.ts`, `scripts/check/run-child.test.ts`, and the native HTTP/recovery tests. | `test` and `test:cov` run once; `test:watch` uses explicit `vp test watch` and stays active to rerun changed tests. Coverage writes reports. `test:ci` checks repository authority, tagged source, portable child execution and loopback server behavior, not rendered conversion. |
| `pnpm check`, `check:test:unit`, `check:test:e2e`, `check:scripts`, `check:windows`, `typecheck` | Browser, Vitest, Playwright, strict NodeNext/erasable script TypeScript, and the Windows validation TypeScript project. `tsconfig.scripts.json` retains its Node-only ES2022 boundary; `tsconfig.windows.json` adds DOM types only for Playwright-evaluated code. | Read-only; `pnpm quality` runs these boundaries. The Node boundary test compiles the full script project with positive Node and negative browser-global probes and checks every Windows module's syntax. |
| `pnpm check:i18n` | `scripts/check/i18n.ts` compares locale JSON key sets. | Reads `src/i18n/*.json`; no writes; failure reports missing/extra keys. Run command plus i18n tests. |
| `pnpm fmt`, `fmt:check`, `lint`, `circular` | Vite+ Oxfmt/Oxlint including CSS formatting and static/type source-cycle analysis. | Read-only; `circular` is a focused alias for native source lint. `fmt:fix`, `lint:fix`, `quality:fix` write fixes and require diff review. |
| `pnpm quality`, `verify` | Quality checks Oxfmt formatting/import order, Oxlint with warnings denied, then browser/unit/E2E/Node types, direct Node tests, and i18n; native lint includes static cycles once. Verify adds production `build:ci`. | Verify generates build output and can update licenses; it excludes Vitest coverage and browser E2E. Inspect generated artifacts and affected tests. |
| `pnpm release:prepare` | `scripts/release/prepare.ts` creates a source/version-bound release bundle after verified build; `scripts/release/publication-guard.ts` with `published-asset.ts` owns live publication order in release workflow. | Reads `RELEASE_VERSION`, optional source identity, built `dist`; writes release assets/metadata/checksums locally. `test/unit/config/{release-infrastructure,release-publication-guard,release-runtime}.test.ts` and artifact inspection. Preparation is not publication. |

`pnpm circular` runs `vp lint src --deny-warnings`; ordinary quality already
runs the same native cycle rule within `lint` and does not repeat the alias.
Oxlint's error-level `import/no-cycle` visits recursive `src/**` TS/TSX,
including root files, deep UI and both independent conversion/WebP Workers.
It retains aliases, type-only and re-export edges, linked-core/external import
traversal (`ignoreTypes: false`, `ignoreExternal: false`) and unbounded depth.
The top-level `worker/` service worker retains its separate TypeScript/build
contract outside the application cycle gate. Node scripts, tests and raw Windows
modules retain their own compiler and runtime checks.

This policy replaces dpdm and deliberately retires global pure/mixed dynamic
import-cycle rejection. Lazy imports and Worker construction keep their existing
behavior tests. Mandatory Knip full/production graph auditing is also retired:
native unused-binding/import checks and TypeScript/build checks remain, but do
not establish that every orphan file, export or dependency is detected. Review
those graphs when their owners change; a separately requested temporary audit
must not recreate a mandatory toolchain. The former entry inventory maps to
`index.html`/app builds, the conversion and WebP Worker builds, service-worker
build, `test`/`test:ci`/Playwright discovery, strict Node script checking and the
Windows profile project. No product source is removed as a consequence of
retiring the graph analyzer.

The license generator validates every declared runtime package's installed
version, license identifier and nonempty license/notice text. When Vite is a
declared development dependency, it also includes the installed Vite package's
license/notice text for browser helpers generated by Vite/Rolldown. Missing or
invalid required input fails the build before replacing `public/LICENSES.md`.
Installed license texts retain their copyright notices.
`scripts/build/wasm-webp-NOTICES.txt` supplies offline native and
generated-runtime notices with their source-attribution limits; review it when
updating that package. The inventory covers declared runtime packages, the
Vite helper owner, and the separate bundled-native notices. It does not cover
every installed build dependency or constitute a binary provenance audit.

### Workflow and subprocess entrypoints

| Surface | Contract; stage and side effects | Verification / status |
| --- | --- | --- |
| `.github/workflows/ci.yaml`, `security.yaml` changed-path jobs | `scripts/ci/classify-workflow-changes.ts` uses the trusted base on PR/merge-group and protected checkout on push, reads Git event and NUL-safe no-renames diff, writes conservative fixed gate outputs. | `test/unit/config/workflow-routing.test.ts` exercises real temporary Git repositories; verify exact-SHA hosted gates run relevant jobs. |
| `.github/workflows/security.yaml` pinned tools and OSV | `scripts/ci/pinned-tools.json` owns tool versions/digests; trusted private `pinned-tools.ts` and `check-pinned-tools.ts` provide image env and freshness checks. The independently pinned browser-core `automation/actions/prepare-osv` supplies the private `consumer` OSV helper; `packages/core` is the runtime gitlink. | `test/unit/config/pinned-tools-cli.test.ts`, `test/unit/config/osv-workflow-composition.test.ts`, and provider OSV fixtures; `docs/osv-workflow.md` explains trust order and live-container limits. |
| `.github/workflows/release.yaml` | `scripts/release/verify-source.ts` checks protected tagged source before validation fan-out; `prepare.ts` creates local files and `publication-guard.ts` plus `published-asset.ts` own the locked public write decision. Short runner `run:` blocks select checkout, append outputs and launch actions. | `test/unit/config/{release-infrastructure,release-publication-guard,release-runtime}.test.ts`, `scripts/release/verify-source.test.ts` and artifact inspection. Preparation is not publication. |
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

`validation/windows/profile.json` declares generated `dist`, named generated MP4/WebM fixtures, `output-contract.json`, and the TypeScript helper closure. The controller packs and imports `profile.ts` under its portable Windows Node with native type stripping, then invokes `run({ browser, root, output })` using the installed stable browser. The prepared Windows controller runs `pnpm prepare:e2e:fixture` and `pnpm build:ci` in a **clean Linux checkout**, then bundles `playwright-core` and portable Node. Guest Node/pnpm/FFmpeg on PATH are not prerequisites.

`pnpm check:windows` checks the full validation implementation without widening the Node-only script project. The Node boundary suite runs `node --check` over every `validation/windows/**/*.ts` module; the E2E output-contract and resource-profile specs cover related behavior. These local checks do not establish desktop, physical codec, GPU or media performance acceptance.

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
The project does not install the Wrangler CLI: no maintained package script, CI
job, local preview or deployment step calls it. Git-integrated Pages consumes
the tracked [Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
and runs the source-build command independently of a checkout CLI. The
installed-Wrangler build-environment projection in [#291](https://github.com/PiesP/wasm-motion-converter/pull/291)
was a one-off diagnostic; the source-build bootstrap receipt and provider log
remain the ongoing checks. An occasional CLI investigation should use an
explicitly reviewed, pinned tool for that investigation, not an implicit download
in project scripts.
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
The tracked `PNPM_VERSION` selects the exact native pnpm release before the
build command starts; keep it aligned with `packageManager`. Node 26 does not
bundle Corepack, and older separately installed Corepack shims select a JavaScript
entrypoint absent from pnpm 12. Confirm the effective pnpm version in the provider
log as well as the bootstrap receipt.

The incident Node definition under `scripts/build/node-build-definitions` supplies
26.12.1 while the provider's upstream version catalog lacks it. Declare
`NODE_BUILD_DEFINITIONS` in tracked Wrangler `[vars]`, pointing to
`/opt/buildhome/repo/scripts/build/node-build-definitions`. The clone phase uses
`/opt/buildhome/clone`, but Pages moves that checkout to `/opt/buildhome/repo`
before installing tools. A successful production Pages deployment confirmed the
tracked Wrangler variable is sufficient with the project-only variable absent;
verify the provider log shows Node 26.12.1 installed before the build proceeds.
The definition admits only Linux x64, verifies the official binary SHA-256, and
rejects compile mode or tarball overrides; it has no source-build fallback. Keep
the exact manifest and `.node-version` checks. A changed provider clone layout
must fail installation, not select an older runtime. Review this definition and
variable together when changing the Node pin or retiring the incident override.

`PAGES_NODE_QUALIFICATION=1` is an opt-in provider-only diagnostic switch. For an
explicit qualification, temporarily prefix the production build command with
`PAGES_NODE_QUALIFICATION=1`:

```bash
PAGES_NODE_QUALIFICATION=1 node --experimental-strip-types scripts/build/pages-build.ts
```

Restore the exact normal build command after retaining the source-bound receipt;
do not keep a project-only flag for normal builds. Combined with `CF_PAGES=1`,
the switch runs the bounded qualifier before installation, records the selected
native pnpm executable, its version and binary hash, the Node executable and CA
settings, and checks Node HTTPS plus one direct and one cross-signed incident
sample through https and fetch. The direct sample is DV
G3B and the AAA-cross-signed sample is EV G3B, two of the coordinator's twelve
chains. These TLS samples describe Node, while the pnpm receipt proves native
binary identity; they do not measure pnpm's own TLS client. Successful receipts
cover only these two samples. Failed timeout/DNS
receipts remain inconclusive; do not treat them as proof that the client rejected
the chain. Ordinary unit CI and the normal build command do not run live probes.
The helper remains available for future explicit qualification.

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

The usual production-verification artifact retains bounded first-GIF and forced
WebP/WASM observations alongside the initial-JS timing. Each successful attempt
keeps browser/cache/Service Worker conditions, source-bound file lengths/hashes,
encoded/decoded/transfer sizes and converted output bytes. Request start times
separate initial requests from requests starting after the pre-upload boundary;
these disjoint groups must not be added to an already cumulative total. Page
Resource Timing does not cover all worker-internal requests. Positive transfer
bytes are observed lower bounds; zero entries may be cached or unavailable,
missing response encodings stay unknown, and runtime memory is not measured.
Compare runs only when source/build inputs and delivery conditions support it.

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

Defer replaying an immutable historical tag that selects an unremediated runtime
until that runtime's trust behavior or an environment-specific mitigation is qualified. The current manifest pin
does not change existing tags.

Each new release-branch artifact contains `release-state.json` with the version and verified
tagged commit. The downloadable `metadata.json` records that same identity.
The release branch now contains a marker: `4478d5d83c95999241c0b26b957ed27ecfeefa59`
records v0.2.3 and source `7de3449ea709e55168d7585dc97cd73de9357f59`.
The initial markerless migration and its archive comparison are preserved at
[`8a3e359a01e7c7594126afff3c94e5a47f248c56`](https://github.com/PiesP/wasm-motion-converter/blob/8a3e359a01e7c7594126afff3c94e5a47f248c56/scripts/release/legacy-state.ts).
An existing branch missing a valid marker stops publication before either writer.
Recovery requires a separate maintainer review of the branch tree, live tag,
public release and source identity, followed by an explicit repair procedure.
The guard does not infer or repair branch state automatically. A true first
publication still works when both the branch and published releases are absent.

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

Vite+ runs Oxfmt and Oxlint for maintained JS/TS, configuration, CSS, and HTML files.
Oxfmt keeps two-space indentation, a 100-column target, LF, single quotes,
semicolons, ES5 trailing commas, and import sorting. The `fmt` block in
`vite.config.ts` is the formatting authority. Oxlint rules and browser-source
overrides live in that file too; `lint` denies warnings. Keep the four explicit
TypeScript project checks because their browser, test, Playwright, and NodeNext
boundaries differ. Vite+ task caching is not enabled.

The Vite alias reports Vite+ `1.4.0` and bundles Vite `8.3.5`. Strict peer
validation stays enabled. `pnpm-workspace.yaml` permits only that exact alias
for the reviewed Vitest, mocker, Tailwind, Solid plugin and vitefu versions,
whose declared Vite ranges include 8.3.5. Recheck callers, their original
ranges and both versions together on updates; never widen this to `allowAny`.
Validate a fresh dependency resolution as well as the frozen install, since
a migration lockfile can otherwise hide peer metadata conflicts.

The maintained scope covers browser source, Node scripts, tests and helpers,
Vite tooling, raw Windows validation modules, the release-runtime action
module, root TypeScript/JSON/HTML configuration, the service worker, 404 page,
and bundled dependency metadata. The shared `packages/core` checkout,
dependencies, generated distributions and reports, lockfiles, media, binary
snapshots, patches, and generated Windows inputs/prior distributions/public
targets are excluded. Vite+ is the sole routine formatter/linter. Oxfmt formats
`src/index.css`; Tailwind/Vite compiles it. The residual Biome gate is retired
under the [common migration policy](https://github.com/PiesP/.github/issues/29).
Its former responsibilities have these dispositions; native alternatives are
purpose-level checks, not claims of identical diagnostics:

| Former Biome responsibility | Maintained policy |
| --- | --- |
| `useConst` | Native `eslint/prefer-const` (error). |
| `useExponentiationOperator` | Native `eslint/prefer-exponentiation-operator` (error). |
| `noSelfCompare` | Native `eslint/no-self-compare` (warning, denied by lint). |
| `useIterableCallbackReturn` | Native `eslint/array-callback-return` (error). |
| `noUselessTernary` | Native `eslint/no-unneeded-ternary` (error). |
| `noUselessSwitchCase` | Native `unicorn/no-useless-switch-case` (error). |
| `noUselessLoneBlockStatements` | Native `eslint/no-lone-blocks` (error). |
| `noSvgWithoutTitle`, `useSemanticElements` | Retired static restrictions; retain native JSX interaction/ARIA checks, meaningful rendered labels, keyboard and accessibility assertions. SVG-title and semantic-element diagnostic parity is not claimed. |
| `noUnusedTemplateLiteral` | Retired; no-substitution template literals are allowed. Unnecessary interpolations are a different question. |
| `noImplicitAnyLet` | Retired; strict TypeScript still permits evolving-any locals and is not an equivalent restriction. Explicit-any and unused-binding lint remain. |
| `useExhaustiveDependencies` (already off in product source) | Retired React-hook analysis; preserve Solid ownership and lifecycle assertions. |
| Recommended CSS lint | Retired; retain Oxfmt, Tailwind/Vite compilation and actual UI checks, without a separate CSS linter. |

Use `fmt:fix`, `lint:fix`, or `quality:fix` for repairs and review their diffs
before committing.

### Modules and TypeScript contracts

- In browser `src/**`, use alias-based leaf imports across folders. Same-folder
  relative imports and package subpaths are allowed. Oxlint's
  `no-restricted-imports` rejects parent-relative imports, `src/` and `/src/`
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
  The small Git-hook Bash adapters keep their documented execution exception.
  Browser aliases do not apply to these entrypoints.
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
  explicit-any, unused-import, or accumulation-spread checks. Solid components
  do not use React's lint plugin. TypeScript's strict projects catch implicit
  `any` contracts but permits evolving-any locals; Oxlint checks explicit `any`.
  The table above records deliberately retired restrictions. The drag-and-drop
  group retains its file, cancellation and progress behavior; fieldset disabled
  semantics would change that behavior. Oxlint keeps `no-control-regex` disabled
  for the existing literal-regex policy. Retain narrowly
  explained exceptions for literal GitHub Actions assertions, inert native
  mocks, asynchronous receiver capture, and cleanup failures raised only when
  there is no primary failure. Do not apply unsafe automatic fixes, broad
  suppressions, automatic async rewrites, or new global warning policies.

The installed Vite+ boundary tests exercise actual warning failure and browser
import restrictions. Relevant references are [Oxlint import restrictions](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports),
[Oxfmt import sorting](https://oxc.rs/docs/guide/usage/formatter/sorting),
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

Vite+ owns the Vite, Vitest, coverage, and core-tool versions. Dependabot keeps
`vite-plus` update PRs visible while omitting ordinary component-version PRs for
`vite`, `vitest`, `@vitest/*`, and `@voidzero-dev/vite-plus-core`. Security updates
and alerts remain visible. For a Vite+ update, select an exact stable release
published at least 24 hours earlier and set `VERSION` to that release. Follow the
[project upgrade guide](https://viteplus.dev/guide/upgrade-project): run
`pnpm dlx --package="vite-plus@$VERSION" vp help migrate`, then
`pnpm dlx --package="vite-plus@$VERSION" vp migrate --no-interactive --no-agent --no-editor --no-hooks`.
Review the managed Vite alias, Vitest and coverage catalog entries, and exact
peer-compatibility selectors against the bundled versions. Confirm fresh
dependency resolution, a frozen install, and `pnpm verify:full` before merging.
Upgrading a global `vp` installation does not update this project's package graph.

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
