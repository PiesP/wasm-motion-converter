# #501 owned VP8 post-owner reachability gate

This validation-only scenario implements the frozen M4 retained-owner protocol.
Run `owned-vp8-owner-retention` in a separate guarded Edge or Chrome functional
session after the V8 timing receipts are sealed. Its receipt is
`owned-vp8-owner-retention.json`. It does not modify the timed job schema or
qualify physical browser, GPU, or RSS reclamation.

The main route forces the conversion Worker unavailable. A page-only wrapper
records each actual owned ABI2 Instance, its returned proxy and exported Memory
through `WeakRef`s. It retains only scalar begin, step, retire, peak and
retirement-time capacity observations. After each completed, Stop, trap, or
explicit recovery attempt reaches its terminal UI state, a page CDP session
requests `HeapProfiler.collectGarbage` three times, separated by 100 ms browser
tasks. One further 100 ms task precedes a fresh scalar weakref inventory.
The receipt calls the resulting sum of retirement-time capacity for live
Memories `liveMutableCapacityBytes`; it is reachability-weighted capacity, not
physical retained bytes. A separate document holds one validation-owned strong
Instance/Memory reference for the negative control, then drops it and repeats
the same checkpoint. That reference is never used in acceptance samples.

The product Worker route creates one Worker per request. A validation-only
Worker bundle prefix observes scalar ABI2 activity and adds a bounded snapshot
to its existing terminal message. The page observer removes that property
before the product handler receives the message and records matching request,
termination and Playwright Worker-close events. For active Stop, the probe reads
a pre-termination scalar snapshot from the live Worker target; the product may
terminate it without a terminal response. A close event within five seconds
confirms isolate disposal, not process memory return. The direct harness Worker
is excluded. The compiled `WebAssembly.Module` cache may remain live and is
excluded from mutable Instance/Memory capacity.

The pure verifier reports `PASS` only for a discriminating negative control,
complete instance IDs, zero live mutable owners at every main checkpoint,
matched Worker termination and close for all five Worker attempts, and intact
192 MiB linear and 96 MiB output bounds. It reports `FAIL` for complete,
valid-control evidence with live owners, confirmed late Worker close, or an
observed bound breach. Missing CDP capability, ambiguous navigation, invalid
control, incomplete ABI or Worker identity, and missing close capability are
`UNVERIFIED`. The existing 512 MiB aggregate accounting is source-bound in the
unchanged product code; this probe does not independently read its private
broker state. The private release path is likewise bound to
`webp-encoder-service.ts` and `owned-vp8-core.ts`, not independently observed.

Whole-program #501 status remains `NOT_VERIFIED` until its independent timing,
functional, platform, host-load, delivery and physical-memory gates have their
own qualifying evidence. A reachability `PASS` never waives another gate.
