# Owned demux read-credit verification

From the repository root, run the finite model and its early-return control on
Linux with Bash, JDK 21, curl, and GNU coreutils.

```bash
bash test/unit/services/owned-read-credit-model/check.sh
vp test run --project unit test/unit/services/owned-demux-source-reads.test.ts
```

The script downloads and verifies the pinned [TLA+ tools v1.7.4
release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4) (TLC 2.19,
revision `5a47802`). Set `TLA2TOOLS_JAR` to a local copy to run offline. The
script verifies its SHA-256 before use and keeps model data outside the
checkout.

## Finite model

`OwnedReadCredit.tla` is an independent state model of one realm. Its config
explores four single-use requests with extents `<<2, 2, 1, 1>>`, two units of
capacity and two waiters. Each request can acquire for a scoped read or try to
obtain a retained lease. Blocked scoped requests queue in submission order.
The head can block a fitting tail. Queue cancellation or timeout removes a
waiter, and a refund or removal can synchronously grant a fitting FIFO prefix.

The model tracks the accounting ledger and per-request debits and refunds
separately from observable ownership, I/O and reply state. TLC checks the
live-credit sum from in-transit grants and outstanding leases, capacity, the
retired subset, a single refund per charge, FIFO order, and immutable replies
once decided. A duplicate begin against a claimed lease represents a rejected
request with no state effect.

One transition represents work completed before the next observation. A grant
charges credit synchronously. Promise continuation and abort are distinct
events, so an aborted grant still consumes credit until the scoped caller
resumes. Before the I/O handler runs, an abort publishes the caller's error and
relinquishes the lease. The underlying promise still owns the charge. Its
successful or failing settlement removes that charge. Ordinary fulfillment can
leave a retained lease outstanding until its owner releases it. For a scoped
success, the model separates settlement from the wrapper's release.

The model assumes serial JavaScript callbacks, valid ranges, and initially
active requests with sources that return native Promises. It treats timeout as an event enabled while
queued. It establishes safety over the finite graph. A retained owner may hold
credit indefinitely, a waiter depends on timer/caller scheduling, and an
unsettled I/O promise can consume credit indefinitely. The production ceiling
and timeout are defined in `owned-demux-source-reads.ts`. The model abstracts
elapsed time, exceptions thrown while creating the I/O promise, and the exact
behavior of installed browsers.

The runner deliberately enables early return after the main check. This must
produce a `CreditConservation` counterexample from submit, resume, and abort,
with the read pending and its charge already refunded.

## Production replay

The Vitest suite observes public entry points, caller outcomes, source calls
and `ownedReadCreditStats()`. Expectations come from the independent contract
above. A controlled range source supplies real JavaScript Promise scheduling
with explicit physical settlements.

| Model event order | Production observations |
| --- | --- |
| Immediate grant or queued grant, abort, resume | Exact capacity charged before resume. An extra lease is refused. The read rejects with the original abort reason and the source is untouched. |
| Begin, wait, abort, late fulfillment or rejection | The first caller rejects promptly. The budget still counts its bytes as live and retired, and the second source is untouched. The late I/O reaction refunds the first charge and grants the successor before its continuation runs. The successor delivers its buffer and returns its own charge. |
| Large head and fitting tail, cancel head | The tail and nonwaiting probes cannot overtake. Cancellation removes the head and immediately charges the tail's grant. Only the tail starts I/O. |
| Duplicate begin, successful settlement, release | Duplicate claims fail before validation or cleanup can touch the original lease. Fulfillment keeps the original retained credit until explicit release. |

The path-filtered **Owned read-credit model** workflow runs both TLC checks when
the model, replay, read-credit implementation or workflow changes. It uses the
runner's JDK 21 and needs only read access to the checkout. The existing CI
classifier routes model and replay files to quality and unit. The replay runs
with the unit coverage job and uses the normal Node test command locally.
