# Pinned security tools

`pinned-tools.json` records the OSV scanner and Semgrep image versions and digests.
The dependency-free `check-pinned-tools.ts` checks the newest stable GitHub
releases older than 24 hours and the OSV tag's GHCR manifest digest. Version
drift warns; missing metadata, API failure, or digest drift fails. It continues
checking later pins after an earlier failure. `pinned-tools.ts env` writes
validated image references to `GITHUB_ENV` and accepts no metadata path. Both
modules are inert on import.

The security workflow loads both helpers and metadata from one immutable,
reviewed revision before using scanner images or checking freshness. Its
privileged jobs never run candidate PR helper code. Update that revision only
after the revised helper closure is reviewed and reachable by full SHA.
The focused CLI fixture test is `test/unit/config/pinned-tools-cli.test.ts`.

Knip discovers the direct Node tests from the package command and disables the Node plugin's
generic `test-*` discovery. The app's `src/test-helpers.ts` is a development runtime
module, so classifying it as a Node test would remove it from production
dependency analysis.
