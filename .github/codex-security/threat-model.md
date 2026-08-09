# dropconvert security context

## Architecture and assets

dropconvert is a static, client-side Vite and SolidJS application. It accepts one
local video `File`, parses and decodes it with MediaBunny and WebCodecs, and
encodes GIF or animated WebP output with gifenc, Canvas, WebCodecs, or bundled
wasm-webp code. Conversion must remain local: there is no backend, account,
application session, upload API, or runtime CDN dependency.

Protect these assets:

- Confidentiality of the user's local input video and generated output.
- Integrity and availability of the page, conversion result, browser tab, and
  persistent service-worker cache.
- Integrity of runtime bundles, WASM, deployment headers, dependencies, CI, and
  release artifacts.

## Trust boundaries and attacker-controlled inputs

- A selected file is untrusted binary input. Its bytes, container structure,
  codec configuration, dimensions, frame counts, timestamps, durations, and
  metadata can be malformed or adversarial.
- Data crossing Worker boundaries is untrusted at runtime despite TypeScript
  types. Request and response discriminants, numeric fields, buffers,
  transferables, cancellation, and lifecycle state require validation.
- Browser APIs, codec implementations, Canvas, WebCodecs, WebAssembly, and
  MediaBunny cross from JavaScript into native or third-party code.
- The service worker and browser cache form a persistent boundary across
  deployments. Network responses and request URLs must not weaken same-origin
  behavior or persist attacker-selected content.
- Vite configuration, `public/_headers`, workflows, dependencies, release tags,
  and Cloudflare publication form the build and release boundary.

## Required security properties

- Input and output media never leave the browser without an explicit, reviewed
  product change and clear user consent.
- Untrusted media cannot cause script execution, arbitrary network access,
  path access, or persistent cache poisoning through application code.
- File size, dimensions, pixels, frames, buffers, queues, workers, retries, and
  conversion time remain bounded. Cancellation and every success or failure
  path release VideoFrames, buffers, decoder/encoder instances, Workers, blob
  URLs, MediaBunny inputs, and other native resources.
- Worker messages are shape-checked, numerically finite and bounded before
  allocation, correlated with the active request, and ignored after settlement.
- Production CSP, COOP, COEP, MIME, framing, permissions, and cache headers stay
  restrictive and consistent with Vite preview behavior. `wasm-unsafe-eval`
  permits WebAssembly compilation, not JavaScript `eval` or `Function`.
- Runtime code is bundled and same-origin. Dependency build scripts, recent
  releases, and trust downgrades remain subject to the pnpm policy.
- Release and CI workflows use least privilege, immutable action pins, trusted
  inputs, and do not expose credentials to code from untrusted pull requests.

## High-value review surfaces

- `src/utils/file-validation.ts`, `src/utils/constants.ts`, metadata extraction,
  demuxing, decoding, frame processing, GIF/WebP encoders, buffer pools, and
  memory planning.
- `src/services/conversion-worker/`, `src/services/worker-pool.ts`, Worker
  protocols, fallback paths, timeouts, cancellation, and cleanup.
- `public/service-worker.js`, `src/sw-register.ts`, `public/_headers`,
  `vite.config.ts`, and generated build integrity checks.
- `package.json`, `pnpm-workspace.yaml`, lockfiles, scripts, GitHub Actions,
  release automation, and Cloudflare configuration.

## Scope boundaries and coverage limits

`packages/core` is a pinned git submodule and file dependency maintained in the
separate `PiesP/browser-core` repository. Scan that repository independently.
This scan should review only WMC's gitlink, imports, integration assumptions,
and consumer-side use; it must not claim source coverage of browser-core.

Static analysis can trace JavaScript and TypeScript control and data flow, but
cannot prove browser-codec safety, GPU/VRAM behavior, WebCodecs implementation
behavior, WASM/native allocator bounds, real process PSS/RSS, Cloudflare's live
headers, or service-worker behavior in an installed browser. Report these as
deferred runtime coverage rather than inferring safety or a vulnerability.
Browser/PSS/RSS tests, deployed-header checks, and dependency scanners remain
separate evidence. Generated output, coverage data, and historical reports are
not source-of-truth scan targets.

Server-side SQL injection, SSRF, CSRF, RBAC bypass, session fixation, and
multi-tenant isolation are out of scope because no server-side authority exists.
A browser-side request issue is reportable only when a concrete application
path violates the local-only or same-origin properties.

## Severity guidance

- **Critical:** remote release compromise or application behavior that
  exfiltrates local media or executes attacker code with durable user impact.
- **High:** attacker-controlled media reliably crashes the tab despite bounds,
  exposes local media, creates meaningful unauthorized requests, or bypasses a
  privileged build/release boundary.
- **Medium:** reproducible, persistent CPU/memory exhaustion or conversion/cache
  corruption from untrusted media until reload or cache recovery.
- **Low:** defense-in-depth gaps with bounded impact or issues requiring
  deliberate local developer/operator action.

Calibrate severity using a demonstrated source-to-sink path, realistic attacker
control, browser mitigations, user interaction, persistence, and affected scope.
