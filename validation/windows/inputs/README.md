# Application update acceptance inputs

The normal Windows media profile runs when `app-update.json` is absent. To select
the focused application-update profile, create this ignored file:

```json
{"schemaVersion":1,"mode":"application-update","buildA":"validation/windows/inputs/deployment-a","baseline":"validation/windows/prior-dist","baselineSourceSha":"<40-character lowercase baseline commit SHA>","baselineTreeSha":"<40-character lowercase baseline tree SHA>"}
```

Place the complete, source-identified production build A in the ignored
`deployment-a/` directory. It must include `index.html`, `service-worker.js`,
`deployment-state.json`, `_headers`, and every `assets/` file. The normal
`dist/` is build B. The existing ignored `validation/windows/prior-dist/`
contains the before-fix baseline. The profile verifies that A and B have
different source identities, the same package version, and byte-identical
service workers before running the browser scenario. It also verifies the
baseline source and tree identities, every listed inventory file's size and
hash, and the `_headers` digest.

The Windows packager copies and hashes this whole directory through
`profile.json`. Keep input source SHAs and distribution digests in the external
campaign receipt. Do not commit generated distributions or the selector file.
