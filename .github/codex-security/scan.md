# WMC Codex Security scan instructions

Review this repository as the client-side media converter described by the
knowledge base. Prioritize exploitable security defects over generic robustness,
style, or maintainability observations.

For every candidate finding:

1. Identify the attacker-controlled source and the exact reachable sink.
2. Trace validation, normalization, resource bounds, browser enforcement,
   cleanup, and fallback behavior along the complete path.
3. Cite concrete files and lines and explain the minimal triggering input and
   realistic user interaction.
4. Demonstrate the security property violated and calibrate impact after current
   mitigations. Do not infer exploitability from an API name or dangerous-looking
   primitive alone.
5. Reject the finding when the path is unreachable, bounded, browser-enforced,
   test/developer-only, or merely duplicates an OSV dependency advisory without
   a WMC-specific exploitable integration path.

Concentrate discovery on:

- Malformed media metadata and container data reaching MediaBunny, WebCodecs,
  Canvas, WASM, allocations, loops, queues, and output assembly.
- Integer overflow, non-finite values, dimension or frame amplification, native
  resource retention, missing backpressure, timeout bypass, and fallback paths
  that duplicate work or memory.
- Worker request/response validation, upper bounds, request correlation,
  transfer ownership, cancellation races, termination, and error cleanup.
- Local-file privacy, blob URLs, logging, browser fetches, service-worker request
  routing/caching, offline persistence, and accidental external transmission.
- CSP/COOP/COEP and Vite/production-header parity, WASM loading, build output
  integrity, workflow trust, dependency policy, and release credentials.

Do not report server-side SQL injection, backend SSRF, CSRF, RBAC, session,
tenant-isolation, or server-secret issues without first showing that the
repository contains the corresponding authority. Do not treat user-selected
local files, browser blob URLs, or same-origin static fetches as server uploads.
Do not claim vulnerabilities in browser codecs or third-party libraries without
showing how this application's integration creates or exposes the condition.

Treat `packages/core` as an independently scanned repository. Review the WMC
gitlink and integration only; do not claim browser-core source coverage.

Coverage output must explicitly list deferred or unverified runtime areas,
including native WebCodecs/WASM/GPU memory, process PSS/RSS under hostile media,
real-browser Worker and service-worker lifecycle, deployed Cloudflare headers,
and any path unavailable because fixtures, platforms, or credentials were not
present. Coverage that omits these limitations is not complete.
