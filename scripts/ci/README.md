# Pinned security tools

`pinned-tools.json` records the OSV scanner and Semgrep image versions and digests.
The reviewed `browser-core/automation/actions/prepare-scanner-pins` Action
copies its dependency-free CLI into private runner storage. The security
workflow separately copies this repository's reviewed JSON to a private file
and passes its absolute path to both `env` and `check`. `env` writes validated
image references to `GITHUB_ENV`; `check` checks stable GitHub releases older
than 24 hours and the OSV tag's GHCR manifest digest. Version drift warns;
invalid metadata, API failure, or digest drift fails. Later checks continue
after an earlier failure.

The workflow pins provider code and consumer data independently by full SHA.
Both paths run after the selected Node setup, and no scanner code or pin data
comes from a candidate PR checkout. The provider snapshots in
`test/fixtures/scanner-provider/` are test-only copies from the reviewed Action
revision. `test/unit/config/pinned-tools-cli.test.ts` checks their byte hashes
and exercises the real Action preparation and CLI without advancing the runtime
`packages/core` gitlink. The workflow Action SHA and caller paths are checked by
`test/unit/config/scanner-pins.test.ts`.

Knip discovers the direct Node tests from the package command and disables the Node plugin's
generic `test-*` discovery. The app's `src/test-helpers.ts` is a development runtime
module, so classifying it as a Node test would remove it from production
dependency analysis.
