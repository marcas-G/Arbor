# AH7 Same-holder Test Classification Implementation

Date: 2026-10-12  
Accepted design landing: `28f9c4fad0eb98ffe763113c33c757b045cae76c`  
Accepted package SHA-256: `57C522120E5E58CAE568C30A96BAE02EC10B0C5C591E8F2A6D3F568E3078FCCC`  
Candidate baseline: `6e0faf53e6efa16afec26b556292ee116ffc6a20`  
Status: **Classification implemented and focused verification complete; independent review and central full gate remain pending.**

## Scope

This implementation only changes AH7 test placement and Store-level test
coverage. It does not change production code, database schema, ports, or
`docs/design/**`. The selected single lease-authorized Worker / serial P3
action boundary and all five strict copied-holder Runtime oracles are retained.

The copied-holder Runtime cases are moved to `.diagnostic.ts` files and exposed
through `vitest.ah7-same-holder-diagnostic.config.ts`. The diagnostic config
includes only the three intended diagnostic files. The copied-holder tests
remain runnable without `it.skip`; their strict effect, settlement and error
oracles have not been weakened. The default process suite continues to include
the live-lease acquisition and G0/G1 post-effect fencing qualifications.

Default Store coverage is in
`adapters/persistence-sqlite/test/p4-ah7-store-concurrency.test.ts`:

- independent SQLite connections claim the same exact invocation identity and
  leave one canonical intent row;
- independent SQLite connections call effect admission for the same persisted
  `NotAdmitted` invocation. A test-only SQLite audit trigger observes exactly
  one `NotAdmitted → MayHaveStarted` durable transition; the final row remains
  unsettled. The test has no ToolRuntime or Executor and makes no single-Executor
  claim;
- an independent controlled no-apply case suppresses the admission update with
  a test-only SQLite trigger and verifies the existing typed
  `PersistenceCorruption<"ToolInvocationStore">` result plus unchanged
  `NotAdmitted` state.

## Accepted-package test-mechanics clarification

The accepted landing package proposed that a losing real two-connection
effect-admission call return a typed compare-and-set no-apply corruption. Static
inspection of the existing `ToolInvocationStore.admitEffect` contract shows a
serialized second call first reads the committed row and returns `Admitted`
when it is already `MayHaveStarted`. SQLite `BEGIN IMMEDIATE` serializes the
transactions, so that production call sequence cannot be used to prove a real
losing-CAS error. This implementation therefore preserves the accepted Store
and production semantics: real concurrency proves one durable transition and
one canonical row; a separate deterministic adapter no-apply case proves the
typed corruption branch. No production behavior was changed to manufacture a
loser result.

This is a test-proof precision adjustment only. It does not alter the accepted
same-holder production boundary or infer AH7 phase closure.

## Verification status

On the clean accepted baseline `6e0faf53e6efa16afec26b556292ee116ffc6a20`:

- `pnpm build`: PASS.
- `pnpm --filter @arbor/web build`: PASS; Vite printed its existing large-chunk
  advisory for the 558 kB main JS asset.
- A single, zero-retry targeted process run passed both default process files:
  `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p4-ah7-tool-settlement-lease-fencing.functional.test.ts tests/functional/process/p4-ah7-live-lease-acquisition.functional.test.ts`.
  Vitest reported 2 files / 2 tests passed in 39.66 seconds. The live-lease
  rejection case passed in 16.636 seconds; the G0/G1 settlement-fence case
  passed in 21.418 seconds.
- The G0/G1 test asserts that the external effect marker occurs exactly once;
  G0 reaches the after-effect boundary at generation 0; G1 acquires generation
  1 through the production LeaseService path; G0's late P4 write is observed at
  `AH7ToolSettlementFenceRejected`; the invocation remains unsettled before
  G1 resumes; there is no successful ToolResult Observation; G1 does not
  repeat the effect; and both invocation and Execution converge to
  `OutcomeUnknown` with no daemon errors. The test fast-forwards the isolated
  fixture expiry before real G1 acquisition; it does not claim natural TTL
  passage. The separate live-lease test passed its real second-daemon
  acquisition rejection case.

On the classification candidate:

- The Store-only default file passed 3/3 tests. Its first run was 2/3 because
  SQLite rejected `INSERT ... DEFAULT VALUES` in a trigger body; changing the
  test-only audit insert to `VALUES (NULL)` fixed the fixture, after which the
  complete file passed 3/3. This failure did not involve production code.
- `pnpm typecheck`: PASS after the final source changes.
- `pnpm lint`: PASS across 1,064 files with one pre-existing warning at
  `packages/agent-runtime/src/model-decision.ts:4070` (`noNonNullAssertion`).
- The explicit diagnostic config was run once before removing the duplicate
  Store-only intent case. The complete recorded output was 3 files / 6 tests,
  5 passed and 1 failed. The strict failure was the preserved pending
  clone-holder oracle at `adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.diagnostic.ts:821`:
  expected `['Success', 'OutcomeUnknown']`, received
  `['OutcomeUnknown', 'OutcomeUnknown']`. The diagnostic files/config executed
  successfully; this red is not a default-suite result or qualification pass.
  Afterward the duplicate Store-only case was removed from the diagnostic file
  because it is now present in the default Store suite. Static census confirms
  five strict Runtime functions remain in the diagnostic files with no
  `it.skip`; they were not rerun after that non-oracle deletion.
- Targeted Biome check on all changed test/config files after the final import
  cleanup: PASS; `git diff --check`: PASS.

The process test runner exited successfully; a final process census found no
Vitest/Arbor process. Only the pre-existing CUA node processes remained. No
production daemon was intentionally left running. No full `pnpm check` or full
`pnpm test:functional` was run for this candidate.

