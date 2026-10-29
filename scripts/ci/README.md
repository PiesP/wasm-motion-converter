# Pinned security tools

`pinned-tools.json` records the OSV scanner and Semgrep image versions and digests.
The OSV digest is the multiarch tag index; the Ubuntu 24.04 runner selects its
Linux x64 child image. Keep the tag digest aligned with the provider check.
The reviewed `browser-core/automation/actions/prepare-scanner-pins` Action
copies its dependency-free CLI into private runner storage. The security
workflow separately copies this repository's reviewed JSON to a private file
and passes its absolute path to `env` and `check --json`. `env` writes validated
image references to `GITHUB_ENV`; `check --json` observes stable GitHub releases
older than 24 hours and the OSV tag's GHCR manifest digest in one pass. The
`pinned-tools` job keeps the provider's exit status, prints status-based workflow
annotations, and uploads only `scanner-pin-observation.json` from runner temp
for seven days, including on failed checks. Version drift warns; invalid
metadata, API failure, or digest drift fails. Later checks continue after an
earlier failure. The JSON binds the validated pin values and executed helper
bytes with SHA-256 and separates release, multiarch tag digest, and unchecked
Semgrep digest observations. The consumer pin source remains independently
reviewed by full SHA.

The workflow pins provider code and consumer data independently by full SHA.
Both paths run after the selected Node setup, and no scanner code or pin data
comes from a candidate PR checkout. The provider snapshots in
`test/fixtures/scanner-provider/` are test-only copies from the reviewed Action
revision. `test/unit/config/pinned-tools-cli.test.ts` checks their byte hashes
and exercises the real Action preparation and CLI without advancing the runtime
`packages/core` gitlink. The workflow Action SHA and caller paths are checked by
`test/unit/config/scanner-pins.test.ts`.

To roll back this observation pilot, restore the two Action references and the
`pinned-tools` check command from the previous reviewed consumer revision, and
remove its observation upload step. Keep the consumer pin JSON and the runtime
`packages/core` gitlink unchanged. A rollback requires the usual protected
workflow checks.

Vite+'s `unit` project runs the scanner fixture and workflow-contract suites
above. The `node-policy` project in `vitest.config.ts` owns repository-authority,
release-source, child-runner and native HTTP/recovery suites. `test:ci` selects
that project without DOM setup or browser mocks; real Node subprocess probes
retain dependency-free execution checks.
`src/test-helpers.ts` remains a browser development runtime module exercised by
browser fixtures. The Node, Windows and service-worker TypeScript/build projects
retain their own runtime boundaries. Routine Knip graph auditing is retired;
review orphan files, exports and dependencies when touching their owners.
