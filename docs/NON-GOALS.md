# What this does not test, and why

A test suite is a budget. Every test costs time to write, time on every run, and
time whenever it breaks for a reason that is not a bug. Deciding what to leave
out is the same job as deciding what to cover, done with less applause.

Each entry here is a deliberate decision with a cost, a reason, and the
condition that would reverse it. Anything untested because nobody thought about
it is not on this list, by definition, which is the weakness of any list like
this one.

## Not tested at all

### Exhaustive REST input validation

**Decision.** Validation is checked once per rule, not once per field.

**Why.** Schemas generate these checks. A test asserting that a string is
rejected where a number is required tests the schema library, which has its own
tests and more users than this exchange will have for a while. The
schema-to-handler wiring is tested once, and the schemas are asserted to exist
on every route.

**Reverses if.** Validation stops being schema-driven, or a handler is found
parsing a request body by hand.

### The frontend as a rendering surface

**Decision.** No component tests, no snapshot tests, no visual regression.

**Why.** The frontend risk that matters is showing a number that disagrees with
the backend, and that is covered by the consistency suite, which asserts
agreement rather than appearance. Whether a button is the right shade is a
review comment. Snapshot tests on a UI that is still moving generate diffs
nobody reads, and a suite people stop reading is worse than no suite, because it
still costs the run.

**Reverses if.** The UI stabilises and a rendering bug reaches production that
the consistency suite could not have caught.

### Third-party library behaviour

**Decision.** No tests asserting that the database driver returns rows or that
the JSON-RPC client makes requests.

**Why.** They have their own suites. What gets tested is this code's use of
them, particularly at the boundaries where assumptions live: what the driver
does with a `bigint`, and whether a failed transaction actually rolled back.

**Reverses if.** A dependency is pinned to a fork, or an upgrade breaks
something a test here could have caught. Then the assumption gets a test, not
the library.

### Gas optimisation

**Decision.** Gas is measured and tracked for regressions. No test asserts that
a function is cheap.

**Why.** A gas budget asserted before the contract's shape has settled is a test
that fails on every honest refactor. A gas report that moves and gets looked at
is more useful than a threshold that gets raised whenever it fires.

**Reverses if.** Gas cost becomes a product constraint, at which point it is a
requirement with a number and gets a test with that number.

### Load beyond the testnet target

**Decision.** Performance work targets the stated testnet throughput and a
safety multiple, not the largest number the hardware will produce.

**Why.** Testing to a number nobody has committed to produces a figure for a
slide. Testing to the committed number plus headroom produces an answer to
whether it will hold. The multiple is written down in
[CI-POLICY.md](CI-POLICY.md) so it can be argued with.

**Reverses if.** A launch commitment changes the number.

## Deliberately incomplete

### FOK fillability ignores hidden iceberg size, and ignores STP

**Decision.** Fill-or-kill judges whether it can fill against displayed quantity
only, and does not account for self-trade prevention cancelling the very
liquidity it just counted.

**Why.** Both alternatives are worse. Counting hidden size means a FOK can
consume liquidity that was never advertised, which hands an information
advantage to whoever can infer iceberg sizes. Running full STP resolution inside
the fillability check means doing the matching twice on the hot path.

**Cost.** A FOK can pass its check and then fill less than its full quantity
when STP interferes, which contradicts the plain reading of "fill or kill". The
engine handles it by cancelling the remainder and leaving the trades already
made against other accounts standing. This is written down in
[../spec/SEMANTICS.md](../spec/SEMANTICS.md) section 4 rather than left for
someone to discover in production.

**Reverses if.** A client relies on the strict reading. Then it is a product
decision about which guarantee to sell, not a testing decision.

### Reorgs are tested to a bounded depth

**Decision.** Reorg handling is tested to a configured depth and no deeper.

**Why.** There is no depth at which a chain is provably final, so "test all
reorgs" has no end. The test asserts the system's stated assumption, and the
assumption is a number someone has to own.

**Cost.** A reorg deeper than the configured depth is untested, and the system
would be wrong in a way nothing here would catch.

**Reverses if.** The chain's finality properties change, or a reorg deeper than
the assumption is observed anywhere.

### Concurrency is tested by interleaving, not by racing

**Decision.** Race conditions are found by driving deterministic interleavings
of operations, not by running many threads and hoping.

**Why.** A test that races is a test that passes on a fast machine and fails in
CI at four in the morning, and gets retried until it passes. Deterministic
interleaving reproduces on demand, shrinks to a minimal sequence, and can be
committed as a regression test.

**Cost.** Only the interleavings the harness knows how to produce are explored.
A real race arising from a mechanism the model does not represent, a database
lock, a network buffer, will not be found this way.

**Reverses if.** A production race is found that the interleaving model could
not have represented. Then the model gains that mechanism, rather than the suite
gaining a sleep.

### Maker-side funding is not reserved offchain

**Decision.** The offchain exchange checks that an *incoming* order can be paid
for before it matches. It does not reserve a resting order's funds, so a maker
whose balance falls after their order rests can still fail to settle.

**Why this is not symmetric with the contract.** The Solidity contract escrows
at placement: funds are locked when an order rests and released as it fills.
The offchain ledger does not, by design, because reservation belongs with a risk
layer that does not exist yet. That is a real asymmetry between the two
implementations and it is written down here rather than left to be discovered.

**Cost.** A maker can rest a sell for their whole base balance and then sell the
same base as a taker. Both orders are individually affordable; together they are
not. The second settlement would throw. The exchange raises
`SettlementInconsistencyError` and stops rather than carrying an engine and a
ledger that disagree, which is the right failure but is still a failure.

**Why not fix it now.** Doing it properly means a reservation model across
order placement, cancellation, partial fills and expiry, which is a feature
rather than a test. Doing it improperly, by checking balances again at
settlement and unwinding, means the engine needs a rollback it does not have.

**Reverses if.** Reservation ships, at which point the offchain ledger should
mirror the contract's escrow and the consistency suite should compare locked
balances as well as totals. Until then the gap is known, named and loud.

### Reorgs are detected, not recovered from

**Decision.** The chaos suite asserts that a reconciler *notices* the divergence
a chain reorganisation produces. It does not assert recovery, because recovery
is not implemented.

**Why.** Writing a test for behaviour that does not exist, and having it pass
because the assertions were chosen to match the absence, is worse than having no
test: it puts a green tick next to a gap. Detection is the prerequisite for
recovery and is the part that must never silently fail, so that is what is
covered.

**Cost.** After a reorg this platform knows it is wrong and cannot yet put
itself right.

**Reverses if.** Reorg handling ships. The detection tests then become the
setup for the recovery tests.

### One browser, not a matrix

**Decision.** End-to-end tests run on Chromium only.

**Why.** The risk this layer covers is the frontend disagreeing with the backend
about state, which is not a per-engine behaviour. Three browsers would triple
the cost and the flake surface for no additional signal.

**Reverses if.** A rendering or API-compatibility bug reaches production that
only one engine exhibits.

### Socket-level reconnect is not tested in the browser

**Decision.** The end-to-end suite tests recovery via a page reload. Cutting a
live WebSocket from a browser test is not done here.

**Why.** It is unreliable to do from Playwright, and the logic it would exercise,
gap detection and re-snapshotting, is already covered precisely in the contract
suite where sequence numbers can be driven directly. Testing it twice, once
badly, adds a flaky test rather than coverage.

**Reverses if.** The reconnect path diverges between what the contract suite can
drive and what a real socket drop produces.

## Tested, but not the way it looks

### The mutation score is not a coverage target

The mutation report is diagnostic. Nothing in CI fails because the score moved.
A number that gates a merge becomes a number people optimise, and mutation score
is cheap to inflate with assertions that kill mutants without checking anything
anyone cares about.

It is also not clean data. Equivalent mutants cannot be killed by any test, and
the score is wrong until a human has triaged them. There is a worked example in
[MUTATION.md](MUTATION.md) of one that cost me an hour and an incorrect
conclusion.

### The differential suite tests two implementations, not one

A divergence says the two engines disagree. It does not say which is wrong. Both
have been wrong. That is the technique working: the suite narrows the question
from "is the exchange correct" to "these two disagree on this five-command
sequence", and a human decides against the spec.
