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

The Worker route uses the actual bundled conversion Worker protocol directly,
with one Worker and a distinct request ID per attempt. The 96 × 64, four-second
clustered VP9 fixture is transferred in a `start` request with the frozen direct
Worker decoder configuration and WebP options. Three requests must complete,
then an active fourth request must show positive owned ABI step activity in its
live Playwright Worker target before a direct `abort` and `terminate`. A fifth,
fresh request must complete in the same page and browser context. This route
qualifies compiled Worker protocol ownership and termination; it does not claim
that the WebP UI selected a conversion Worker or that direct termination is the
UI Stop action. The main UI route separately retains its Stop-to-idle within
500 ms and no-publication requirements.

A validation-only Worker bundle prefix observes scalar ABI2 activity and adds
a bounded snapshot to each matching terminal message. The page observer removes
that property before ordinary handlers receive the message and records matching
request, termination and Playwright Worker-close events. For direct active
termination, the probe reads a pre-termination scalar snapshot from the live
Worker target. A close event within five seconds confirms isolate disposal,
not process memory return. Missing Worker identity or close capability remains
`UNVERIFIED`; no post-close zero capacity is inferred without a matched close.
The compiled `WebAssembly.Module` cache may remain live and is excluded from
mutable Instance/Memory capacity. Completed output is a real transferred WebP
buffer, bounded by the 96 MiB product ceiling and the tighter 8 MiB small-fixture
transport bound; the guest must save, parse and decode its actual bytes.

The prefix requires a `DedicatedWorkerGlobalScope` before it changes
`WebAssembly.Instance` or installs its message listener. It accepts a `start`
request only from the parent Worker channel, whose implicit-port `message`
event has `source === null`; a message with a Window, MessagePort, or Service
Worker source cannot replace its request ID. This is a Worker protocol check,
not a cross-window origin comparison. The prefix is injected only into the
inventoried conversion Worker response for this functional session; it is not
part of the production bundle. The Node VM unit checks exercise the scope and
message boundary, while the installed-browser run must establish that the
actual dedicated Worker accepts its parent start request. A synthetic
same-scope dispatch could also have a null source; this guard does not claim
to authenticate arbitrary script already executing inside that Worker.

The [Worker messaging algorithm](https://html.spec.whatwg.org/multipage/workers.html)
uses the implicit port, and the [message-port dispatch steps](https://html.spec.whatwg.org/multipage/web-messaging.html#message-port-post-message-steps)
initialize data and ports without a source, leaving `MessageEvent.source` null.

The guest reads the direct child installed browser process and executable
digest before and after the functional session. An unavailable or changed
identity leaves the reachability receipt unverified. This observation does not
measure host-neighbor load.

The pure verifier reports `PASS` only for a discriminating negative control,
complete instance IDs, zero live mutable owners at every main checkpoint,
matched direct Worker termination and close for all five Worker attempts, and
intact 192 MiB linear and 96 MiB output bounds. It reports `FAIL` for complete,
valid-control evidence with live owners, confirmed late Worker close, or an
observed bound breach. Missing CDP capability, ambiguous navigation, invalid
control, incomplete ABI or Worker identity, and missing close capability are
`UNVERIFIED`. The existing 512 MiB aggregate accounting is source-bound in the
unchanged product code; this probe does not independently read its private
broker state. The private release path is likewise bound to
`webp-encoder-service.ts` and `owned-vp8-core.ts`, not independently observed.

Whole-program #501 status remains `NOT_VERIFIED` until its independent timing,
functional, platform, host-load, delivery and resource gates have their
own qualifying evidence. A reachability `PASS` never waives another gate.

## Frozen run 01 and corrected scope

The source-bound run 01 at `261cb630616062e020a1b5c43f64ddadb9a1f0b9`
remains `UNVERIFIED` with `workerCount: 0` and “Product Worker creation was not
observed.” Its main-route seven checkpoints and negative control remain retained
sub-observations; they do not retroactively pass the whole gate. At that source,
`src/hooks/conversion-handlers/use-perform-conversion.ts` sends WebP to
`runConversionPipeline` on the main thread, so the original Worker UI premise
cannot occur. The corrected direct compiled-Worker criterion above must be in
the protocol before a fresh runtime attempt and its separate receipt. It narrows
the Worker claim to the actual compiled protocol and preserves the UI Stop
criterion as a separate main-route observation.
