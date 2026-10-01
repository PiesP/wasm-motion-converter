# Deep code-analysis reuse

The scheduled deep workflow may reuse successful duplication or mutation results
for unchanged tracked bytes, file modes, gitlinks, configuration, locks, declared
Node/pnpm versions, pinned tools/actions, gate, OS, architecture, ImageOS and
runner label. Manual runs default to fresh analysis; `reuse_success=true` opts in.
Unknown runner identity, missing/corrupt markers and cache failures run fresh.
Each successful run saves an immutable version 3 marker with its run ID, attempt,
SHA, and analysis time. Before reuse, the workflow checks the origin and every
later selected gate against bounded, paginated Actions history. A later failed,
cancelled, or unfinished gate, a rerun, or unavailable history runs fresh. A
successful fresh pass can replace an invalidated result on the next schedule.
Mutation success is recorded only after its required report upload succeeds.

This is bounded reuse of a code-analysis result. Ubuntu image build revisions
(`ImageVersion`) are recorded as provenance but excluded from the key, allowing
weekly image refreshes at the same platform and label. It does not certify an
identical execution environment. Force a fresh manual run when investigating
runner/tool behavior. Security intelligence and external browser compatibility
checks retain their existing triggers and do not use this marker.

Local regression checks: `pnpm test:ci` and `pnpm check:scripts`.

Knip discovers this Node test from its package command and disables the Node plugin's generic
`test-*` discovery. The app's `src/test-helpers.ts` is a development runtime
module, so classifying it as a Node test would remove it from production
dependency analysis.
