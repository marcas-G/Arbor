# AH7 / P4 concurrent invocation settlement ownership — draft

Status: **Design Gap proposal; not accepted and not implemented**

Scope: P4 `ToolRuntime` concurrent calls using the same `(executionId,
invocationId)` where one caller owns a live non-idempotent effect and another
caller re-enters before that effect owner's settlement is durable.

## Evidence

The deterministic regression is in
`adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`:

1. Two OS processes connect to the same SQLite database and are both held at
   the `ToolDefinitionStore.definition` barrier before either invokes.
2. Worker A is released first. It records the unique `ToolInvocation` intent,
   appends the external-effect marker exactly once, then the existing
   `AH7AfterToolEffectBeforeSettlement` qualification probe holds it before
   settlement.
3. Only after A reports the post-effect/pre-settlement boundary, worker B is
   released with the exact same `ToolInvocationId` and intent. B returns
   `OutcomeUnknown` from the existing-prior unsettled `NonIdempotent` path.
4. After B has finished, A is released to persist its known `Success` result.
5. The test proves both runtime results (`A=Success`, `B=OutcomeUnknown`) and
   exactly one external-effect marker. It fails only at durable state: the
   single invocation row is already terminal `OutcomeUnknown`, not `Success`.

The focused test fails deterministically at the final `settlement_kind`
assertion. The earlier nondeterministic cross-process test also failed once in
the full `pnpm check` run: its runtime-outcome and one-effect assertions passed,
but its durable row was `OutcomeUnknown`. Six immediate focused reruns of that
old race passed; they do not negate the deterministic counterexample.

Relevant current code:

- `packages/tool-runtime/src/runtime.ts`: after finding an existing unsettled
  `NonIdempotent` invocation, the re-entry persists `OutcomeUnknown` and
  returns that observation.
- `adapters/persistence-sqlite/src/tool-invocations.ts`: `settle` updates only
  `WHERE invocation_id = ? AND settled_at IS NULL` and does not report whether
  it updated one row. Thus a later owner `Success` settlement can be a no-op
  after the competing re-entry has terminalized the row, while the owner still
  returns its successful observation.

## Frozen-contract reading

The current owners establish these relevant rules:

- P4 `01` §2 and §5: `NonIdempotent` automatic replay is forbidden on
  ambiguity; `OutcomeUnknown` may coexist with an external effect.
- P4 `02` §1–§2 and §5: invocation follows intent/authorization/resource
  checks, Execute, durable Settlement, then bounded observation; ambiguity
  becomes `OutcomeUnknown` and must not be blindly replayed.
- P4 `06` §2–§4: intent precedes external effect; dangling invocations are
  discoverable; P2 `ReconciliationSource` enumerates unresolved references and
  recovery decides between unknown and safe settlement.
- SD §6.5 and §10.4; DID §6A.7 and §9.12: “no result” is not proof of no
  effect, and unresolved non-idempotent effects must not be automatically
  replayed.

These rules do not say whether a second caller seeing an unsettled intent may
durably terminalize it while its original effect owner is still live. The
`tool_invocations` record has no owner/fencing/lease field, and the P4 port does
not distinguish an active invocation from a crash-abandoned intent. Therefore
the counterexample exposes an unclosed concurrency semantic; this proposal does
not claim that the existing text unambiguously authorizes a particular fix.

## Governance decision requested

Choose the P4 meaning of same-key re-entry while an earlier effect owner may
still be active:

1. **Owner-preserving settlement (recommended):** only the caller that
   successfully admitted the unique intent may durably settle its execution;
   a competing re-entry cannot write a terminal `OutcomeUnknown` over that
   owner's pending settlement. The re-entry must fail closed or return a
   non-terminal/ephemeral unknown result without changing the durable row.
   A's eventual known settlement remains canonical. Crash recovery still treats
   a genuinely abandoned dangling intent as unresolved and never replays a
   non-idempotent effect.
2. **Durable unknown wins:** any re-entry that observes a dangling
   non-idempotent intent may terminalize it as `OutcomeUnknown`, even if its
   original owner is live. If chosen, the contract must state what A returns
   when its subsequent known settlement loses the terminal-state CAS and how
   that observation is represented without contradicting durable state.
3. **Explicit owner/lease/fencing:** persist a bounded owner claim so a
   duplicate can distinguish a live owner from an abandoned intent. This
   requires deciding the owner identity, lease/expiry authority, crash/restart
   detection, and fencing of stale settlement; it is broader than this minimal
   qualification.

The preferred invariant is that external effects remain at-most-once, the
unique invocation has one canonical settlement, and a live effect owner's
known result cannot be silently discarded by a competing same-key re-entry.
This is a recommendation for governance, not an accepted contract.

## Required qualification after ruling

The deterministic two-process test should retain all of these assertions:

- A reaches the real post-effect/pre-settlement boundary before B is released.
- A and B use the same `ToolInvocationId`, same exact intent, and same
  database file; their PIDs are distinct.
- The external-effect marker occurs exactly once.
- B does not execute the effect and returns only the contractually selected
  loser outcome.
- A's owner outcome and the single durable settlement are consistent with the
  governance ruling; no competing write can silently replace the owner result.
- There is one intent row and one terminal settlement row, with no second
  invocation/observation/effect.
- A crash-abandoned non-idempotent intent remains unresolved/unknown and is
  never automatically replayed.

No assertion should be weakened to merely accept either `Success` or
`OutcomeUnknown` without checking which caller owned the effect and whether the
durable row agrees with that owner's actual result.

## Not in scope

- Changing P4 `SideEffectSemantics`, making non-idempotent effects replayable,
  or relaxing at-most-once effect qualification.
- Resolving AH7 crash/restart, approval/settlement atomicity, Observation
  replay, or general execution lease/fencing questions.
- Choosing a SQL schema, owner token, lease, or process-local workaround before
  the governance ruling.
- Modifying `docs/design/**` or production implementation in this proposal.
