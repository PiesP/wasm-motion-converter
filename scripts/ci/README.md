# Pinned security tools

`pinned-tools.json` records the existing Nose installer version and SHA-256,
OSV scanner image version and digest, and Semgrep version and image digest.
The dependency-free `check-pinned-tools.ts` checks the newest stable GitHub
release older than 24 hours, the Nose release asset digest, and the OSV tag's
GHCR manifest digest. Version drift warns; missing metadata, API failure, or
digest drift fails. It continues checking later pins after an earlier failure.
`install-nose.ts` downloads the installer over HTTPS, checks its bytes before
running `sh` without GitHub tokens, and appends to `GITHUB_PATH` only after
success. `pinned-tools.ts env` writes validated image references to
`GITHUB_ENV` and accepts no metadata path. All three modules are inert on import.

The security workflow resolves scanner images from the immutable reviewed
`7a5ab41114bfe234b4524303680f792266b551d3` revision and passes them to the
OSV and Semgrep jobs. Its freshness job uses that revision too. Deep verification
and release duplication retrieve the installer and metadata from the same SHA
with `git show`, even after a release checkout. Each job sets up Node before
running a private copy of the helpers. The privileged security jobs never run
candidate PR helper code. Update the SHA only with a reviewed pin change.
The focused CLI fixture test is `test/unit/config/pinned-tools-cli.test.ts`.

# Deep code-analysis reuse

The scheduled deep workflow may reuse successful duplication or mutation results
for unchanged tracked bytes, file modes, gitlinks, configuration, locks, declared
Node/pnpm versions, pinned tools/actions, gate, OS, architecture, ImageOS and
runner label. Manual runs default to fresh analysis; `reuse_success=true` opts in.
Unknown runner identity, missing/corrupt markers and cache failures run fresh.
Each cacheable fresh success can publish an immutable version 3 marker with its run ID, attempt,
SHA, and analysis time. Before reuse, the workflow checks the origin and every
later selected gate against bounded, paginated Actions history. A later failed,
cancelled, or unfinished gate, a rerun, or unavailable history runs fresh. A
successful fresh pass can replace an invalidated result on the next schedule.
Mutation success is recorded only after its required report upload succeeds.
When the originating job exposes a completed analysis step with valid timestamps,
the reuse summary estimates avoided analysis seconds from that step alone. Missing
or invalid step timing leaves the estimate unavailable. It excludes restore and
Actions API overhead and does not measure net runner time or billed minutes.

This is bounded reuse of a code-analysis result. Ubuntu image build revisions
(`ImageVersion`) are recorded as provenance but excluded from the key, allowing
weekly image refreshes at the same platform and label. It does not certify an
identical execution environment. Force a fresh manual run when investigating
runner/tool behavior. Security intelligence and external browser compatibility
checks retain their existing triggers and do not use this marker.

Reruns (`GITHUB_RUN_ATTEMPT > 1`) always analyze selected gates afresh, including
scheduled runs and manual reuse opt-ins. Actions run listings expose only the
latest attempt, so excluding the current attempt can hide its prior failures.
A successful fresh rerun may still publish its own marker for a later run's
first-attempt reuse.

Local regression checks: `pnpm test:ci` and `pnpm check:scripts`.

Knip discovers this Node test from its package command and disables the Node plugin's generic
`test-*` discovery. The app's `src/test-helpers.ts` is a development runtime
module, so classifying it as a Node test would remove it from production
dependency analysis.
