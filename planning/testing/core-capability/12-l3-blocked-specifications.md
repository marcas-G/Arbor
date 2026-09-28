# L3 Test Specifications for Implementation/Design-Blocked Capabilities

**Status:** test specification only (no executable sentinel, no product
implementation change, no blocker removal).
**Scope:** B06, B07, B08, B09, B10, B11.
**Rule:** each card below is the ready-to-implement L3 sentinel contract for
the day its blocker closes. Until then the case-catalog keeps
`BLOCKED_BY_IMPLEMENTATION` (B06–B09, B11) and `BLOCKED_BY_DESIGN_GAP` (B10)
with `testFile: null`. Implementing a sentinel must not smuggle in an
unauthorized route (08-known-failures.md disposition).

Shared harness baseline for all cards: `tests/capability/support/public-chat.ts`
(public HTTP face + `withPublicConversationApp`), `support/work-execution.ts`
(public CreateProject/AssignWork + production `admitExecution`/`runExecution`
drive), `support/capture.ts` (evidence), `real-provider/http-sdk-client.ts`
(real provider capture). B12 additionally demonstrates the spawn-restart
harness pattern (`b12-restart-continuation.test.ts`).

## B06 — Parent / Child Communication

- **Blocker:** adopted model-facing control route (ControlToolRegistry →
  AgentAction) not implemented/authorized; BlobStore-to-Message body path not
  integrated.
- **Unblock condition:** DID v1.18 Appendix C authorization flips to
  AUTHORIZED; SendMessage control action reachable from a real model turn;
  message body round-trips BlobStore.
- **Drive:** parent Work execution with objective "send a Query to child
  workspace <C> asking <Q> via arbor_send_message"; child workspace seeded
  through the public CreateChildWorkspace command; child reply submitted
  through its own public conversation face.
- **Oracle:** durable `messages` row with BlobStore-resolved body; child Inbox
  admission for the Query; correlation closes on the child Reply; parent
  Report reaches the parent Inbox; the next parent provider request (captured)
  contains the child message content. Negative: wrong recipient/correlation
  must not be admitted (assert no Inbox row).
- **Ready checklist:** none of the oracle reads a command receipt as success.

## B07 — Responsibility Delegation

- **Blocker:** model-driven proposal requires the unimplemented adopted
  control route; ResponsibilityHandoff deferred.
- **Unblock condition:** control route authorized + ProposeChildWorkspace
  action decoded/handled through it; governance decision path (RecordDecision)
  already public.
- **Drive:** parent conversation/Work turn whose objective includes "propose a
  child workspace for responsibility X via arbor_directive
  ProposeChildWorkspace"; then the authorized human decides through the public
  RecordDecision command.
- **Oracle:** exactly one durable Child Workspace + its intended Work after
  proposal + decision; child responsibility/authority boundaries match the
  proposal; no child created for a local-only control case; no unauthorized
  child (assert workspace count).

## B08 — Specialist Delegation

- **Blocker:** model-selected SpawnSpecialist action requires the adopted
  control route.
- **Unblock condition:** control route authorized + SpawnSpecialist decoded
  and routed as an execution-bound binding.
- **Drive:** a Work execution whose objective requires a bounded specialist
  subtask; the model invokes SpawnSpecialist with a mission; the specialist
  execution runs (scripted objective) and returns its result.
- **Oracle:** result returns exactly once to the caller (session/correlation);
  specialist execution settles and leaves no live lease/session; no durable
  Responsibility or permission grant is created (assert repositories empty).

## B09 — Dependency / Deliverable

- **Blocker:** no adopted model-facing dependency/deliverable action route in
  the current composition.
- **Unblock condition:** DeclareDependency (or the frozen equivalent in the
  adopted route) reachable from a model turn.
- **Drive:** two Workspaces (producer/consumer) via public commands; producer
  declares a deliverable through the model-facing route; consumer declares one
  matching and one deliberately non-matching ExpectedDeliverable.
- **Oracle:** only the structurally matching deliverable satisfies the
  dependency and wakes the consumer (scheduler state Admit); the mismatch
  leaves the consumer blocked; matcher outcome is durable and externally
  readable. The model's intent alone is never success evidence.

## B10 — Verification

- **Blocker (design):** G-V2-2 (ToolObservation exact source identity),
  G-V2-3 (ConcludeVerification durable summary reference), G-V2-4
  (initialWork/VerificationMission lifecycle) remain DESIGN_UNRESOLVED
  (`planning/tool-surface-review/40/41/44`).
- **Unblock condition:** governance rulings land in DID closing G-V2-2/3/4 and
  the P8 durable Verification→ref association is implemented.
- **Drive:** verifier execution (real provider) over a frozen mission with
  evidence-bearing artifacts created through supported storage/observation
  paths only.
- **Oracle:** verdicts are distinguishable Pass/Fail/Unknown per criterion
  with resolvable evidence sources; the producer cannot write verification
  state (negative: attempt fails closed); the conclusion is durably traceable
  to its summary reference. No fabricated ToolObservation references.

## B11 — Completion / Acceptance

- **Blocker:** producer judgment (completion claim) through the adopted
  model-facing route not implemented/authorized; deterministic gates are L2.
- **Unblock condition:** CompletionClaim decoded through the authorized
  control route.
- **Drive:** producer Work whose objective ends in a model completion claim;
  one valid chain and three invalid variants (stale revision, non-PASS
  verification, unauthorized actor) driven through the public command face.
- **Oracle:** valid chain completes the Work exactly once (lifecycle Open →
  Completed, single transition event); each invalid variant fails closed with
  no lifecycle mutation and a durable rejection record; Parent/Human
  acceptance occurs only where policy requires it.

## Coverage ledger

After this specification pass the L3 column is 14/14 covered:

| Capability | L3 form |
|---|---|
| B01, B04 | executable (`b01-b04-conversation.test.ts`) |
| B02, B03 | executable (`b02-s01e-executable.test.ts`, `b03-s01c-control.test.ts`) |
| B05 | executable, expected FAIL until steer-to-cognition promotion exists |
| B06–B11 | this specification (blocked, no test file by design) |
| B12 | executable process-restart harness (`b12-restart-continuation.test.ts`) |
| B13, B14 | executable (`b13-failure-recovery.test.ts`, `b14-web-projection.test.ts`) |

Coverage ≠ PASS: B05 documents a live capability gap; B06–B11 stay blocked
until their governance/implementation conditions close.
