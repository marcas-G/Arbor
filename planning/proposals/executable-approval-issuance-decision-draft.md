# Executable approval issuance/decision/resume

**Gap:** `EA-DG-01` — approved Executable handoff is not wired end to end

**Proposed decision:** `ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME`

**Status:** DRAFT / AWAITING MANUAL ACCEPTANCE

**Semantic baseline:** accepted AH7-DG-03 landing at `5cab270642f3a738f1da3dcb846ce734d477f8b2`; CAPA Control approval remains a separate route.

## 1. Decision requested

Add one human approval handoff for approval-required Executable tool calls. Reuse the existing exact `InvocationApproval`, unified `action_approvals` storage, Governance Inbox projection and P3 same-step resume machinery, while keeping the `Executable` and `Control` routes strictly distinct.

```text
model ToolCall
  → Runtime derives stable ToolInvocationId and exact action binding
  → current PermissionGrant / InvocationAuthority check
  → P4 says this exact intent requires approval
  → Runtime issues one exact Pending Executable approval + Inbox entry
  → Execution pauses; same AgentLoopStep action remains Pending
  → human Approve / Reject, or Runtime Expire / Cancel, exact revision
  → daemon wakes the same Execution and replays its pinned Provider result
  → same LogicalActionId and ToolInvocationId resume
  → P4 rechecks current authority and atomically claims intent + approval
  → effect admission and settlement follow accepted AH7-DG-03 / P9 rules
```

The model supplies tool identity and arguments only. It cannot provide, select,
or alter an `ApprovalId`, `ToolInvocationId`, resource resolution, authority
fact, action digest, ControlBasis digest, expiry or approval state. The
Runtime derives those from the pinned Provider result and current trusted
Execution context.

This proposal adds no capability to `PermissionGrant`, does not widen
`Sandbox` or `ResourceBoundary`, and does not reuse Control `ActionApproval`
as an Executable credential. An approval is consent to one exact invocation;
it does not grant standing permission.

## 2. Failure evidence and current boundary

The current implementation cannot complete the requested human handoff:

1. `apps/single-workspace/src/executable-tool-handler.ts` constructs every
   `ToolIntent` with `approvalId: null` (line 185 at the semantic baseline).
2. `packages/tool-runtime/src/runtime.ts` checks the per-intent
   `requiresApproval` predicate (lines 309–312). A required call with no ID
   goes through P4 no-effect `Denied(ApprovalRequired)`; it is not a pending
   human interruption.
3. `packages/application/src/authority-resolver.ts` exports
   `resolveApproval`, but it is a pure fact producer. The P12 contract says
   `R = never`, and the function itself creates no durable row or Inbox entry.
   There is no production call site that issues this fact.
4. The production Pending/Inbox writer is
   `apps/single-workspace/src/control-action-authorizer.ts`; it creates
   `route_kind = 'Control'` and `cap:<id>:<revision>`. The Web parser and
   `ResolveControlApproval` command accept that Control route only. They do
   not create an Executable `InvocationApproval`.
5. The current denial is terminal under P3's action ledger contract: the
   Executable action is rejected and its cursor advances. That identity cannot
   later be changed into a resumable approval pause.

These are source-level observations, not a newly run failing test. No tests or
production process were run while preparing this proposal. AH7-DG-03 store
claim qualification with a test-seeded approval proves only P4 consumption
semantics; it is not evidence of production issuance, Inbox admission, human
decision, daemon wake or same-action recovery.

Relevant source contracts and implementation are listed in §11. In
particular, P4 `01`/`02`/`03`/`06` at the accepted AH7-DG-03 landing govern the
pre-effect claim and denial boundaries; P2 `03` governs the trusted lease
triple and stop ordering; P9 `02`/`07` govern crash and action recovery; CAPA
governs the separate Control route.

## 3. Chosen model

### 3.1 Exact request identity

When a P4 `requiresApproval(intent)` predicate is true and the current exact
intent has no approved Executable approval, the Application composes the
trusted facts and persistence work. P12 `resolveInvocation` must first produce
an authorized `InvocationAuthority`; P12 `resolveApproval` then produces the
exact approval fact. A denied or unresolvable authority never creates a
human-approval request.

The request binds at least:

```ts
type ExecutableApprovalBinding = {
  readonly approvalId: ApprovalId;             // Runtime-generated
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly agentLoopStep: AgentLoopStepIdentity;
  readonly logicalActionId: LogicalActionId;
  readonly callRef: string;
  readonly toolInvocationId: ToolInvocationId; // same ID used after approval
  readonly principal: Principal;               // authenticated Runtime fact
  readonly toolName: string;
  readonly toolVersion: string;
  readonly actionDigest: string;                // canonical exact parameters
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
  readonly expiresAt: string;
};
```

The ApprovalId is generated from trusted route identity and the exact binding,
so replay of the same pending action converges on the same row. It must not be
derived from model-supplied approval data. The store additionally retains the
exact validated arguments needed to verify the action digest; queue text is not
the authority source.

The accepted P4 `InvocationApproval` fields remain authoritative. Amend that
record and the Executable approval row with the exact
`toolInvocationId`/AgentLoopStep action binding; do not infer this binding
later from Session text, a Control approval, or a matching argument string.
The physical ledger may remain `action_approvals`, but every read, insert,
decision and consume for this flow must include `route_kind = 'Executable'`.
Control code must continue to require `route_kind = 'Control'`.

### 3.2 Pending creation and interruption

P4 must expose a typed, nonterminal `ApprovalRequired` handoff when approval
is required but absent or still Pending. This is not a
`CanonicalToolObservation`, a P4 terminal Denied, or a settled ToolInvocation.
The Application uses the resolved P4 intent and P12 facts to atomically:

1. insert or read the exact `route_kind = 'Executable'` Pending approval;
2. admit its exact revision to the Governance Inbox with a distinct key,
   `eap:<approvalId>:<revision>`;
3. confirm that the bound AgentLoopStep action is the same Pending action.

Repeated issuance with the same exact binding is idempotent. Reusing the same
ApprovalId with any different binding is an invariant conflict and fails
closed. The Inbox row is not promoted into an Agent Session.

The existing `ExecutionDriveOutcome.ApprovalRequired` is the durable pause
surface: the Execution remains Active, no Execution settlement is written,
the AgentLoopStep remains at `ActionsInProgress`, the same action stays
Pending, and the current lease is released. The daemon does not poll/replay an
Execution while an exact Executable approval is Pending. The approval row and
Inbox entry are the durable reason for this pause; no new Provider request is
permitted to reconstruct the action.

### 3.3 Human decision and wake

Add an External human command `ResolveExecutableApproval` with the exact
ApprovalId, expected revision, and `Approve | Reject` decision. It is a
separate registered route from `ResolveControlApproval`; its authority fact,
codec, handler and queue parser cannot accept Control IDs or evidence.

The command transaction:

- loads only an Executable approval in the requested project/workspace;
- verifies the bound Execution is still active and the exact revision is
  Pending and unexpired;
- applies a compare-and-set decision, increments revision once, records the
  authenticated human and decision time, and consumes the exact Inbox entry;
- appends the typed resolution event and commits the command receipt atomically.

After commit, a resolved-approval consumer wakes the same Execution. Approve,
Reject and Expire all wake that same execution because the action must receive
a typed terminal outcome or resume; none creates a new Execution, Step,
ProviderTurn or action identity. The same settled Provider result is replayed
locally. On Approve, the Executable handler passes the Runtime-selected
ApprovalId with the same ToolInvocationId into P4. On Reject or Expire, no
Sandbox/Executor call occurs; the action receives a typed denied ToolResult,
becomes `TerminalRejected`, writes its sourced Observation and advances the
cursor exactly once.

Expiration is deterministic at `expiresAt`: the daemon/sweeper performs a
revision-checked `Pending → Expired` transition, consumes the exact Inbox entry
and emits/wakes through the same resolution path. Decision after expiry is a
typed stale/expired result and cannot approve the action. Duplicate command or
consumer delivery returns the original receipt/result and does not decide,
consume or wake a second logical action.

The route state transitions are:

```text
Pending(r)  → Approved(r+1) | Rejected(r+1) | Expired(r+1) | Cancelled(r+1)
Approved(r) → Consumed(r+1) | Expired(r+1) | Cancelled(r+1)
Rejected / Expired / Consumed / Cancelled are terminal
```

Every transition is one compare-and-set on `route_kind`, ApprovalId, current
revision, state and applicable expiry. `Consumed` is written only by the P4
claim transaction. If the expiry boundary has passed when the decision or
resume path runs, that path performs or converges the exact `Expired`
transition instead of returning an unrecorded timeout.

### 3.4 Current authority, claim and effect

Approval does not bypass a changed grant, target, tool version, resource
resolution or ControlBasis. On resume the Runtime re-resolves current
`InvocationAuthority`, canonical resources and P4 admission. Only then may the
accepted AH7-DG-03 fenced claim transaction atomically persist the exact
ToolInvocation intent and consume this approval for its bound
ToolInvocationId. P4 rechecks authority, approval binding, stop state and the
full current lease tuple at effect admission before setting
`MayHaveStarted`.

If current authority is denied before claim, P4 writes a durable no-effect
Denial for that same invocation; the approval remains unconsumed and cannot be
transferred to another action. If authority changes after claim but before
effect admission, P4 records `ApprovalNoLongerAuthorized`; the approval stays
consumed by the same invocation. Once `MayHaveStarted` commits, AH7/P9
side-effect reconciliation applies. Never refund or transfer a consumed
approval after interruption, revocation, lease loss or unknown effect.

## 4. Terminal outcomes and stop ordering

The following outcomes close the waiting action once and do not settle the
Execution merely because approval failed:

| Cause | Approval state / P4 effect | AgentLoop result |
|---|---|---|
| Human Reject | `Rejected`; no P4 intent/effect | Typed `Denied(ApprovalRejected)` ToolResult; `TerminalRejected`; one cursor advance |
| Expiry | `Expired`; no P4 intent/effect | Typed `Denied(ApprovalExpired)` ToolResult; `TerminalRejected`; one cursor advance |
| Grant/authority revoked before claim | Approval remains unused and bound; P4 no-effect Denied | Typed authorization denial; `TerminalRejected`; one cursor advance |
| Revocation after claim, before admission | approval consumed by this invocation; P4 `Denied(ApprovalNoLongerAuthorized)` | Typed Denied; `TerminalRejected`; one cursor advance |
| Stop before request admission | no request/intent/consumption | P2 `ExecutionStopping`; same Step proposes `Interrupted(StopRequested)` |
| Stop while Pending/Approved but before P4 claim | no intent, no consumption; approval is closed as Cancelled and Inbox consumed in the stop transaction | typed Interrupted result; current action `TerminalRejected`, remainder `SkippedEarlySettlement`, one cursor advance |
| Stop after claim, still `NotAdmitted` | consumed approval remains bound; P4 `Interrupted` | same action/result/cursor convergence under P3/P9 |
| Stop after `MayHaveStarted` | no new call/replay; reconcile by side-effect semantics | unresolved-side-effect gate; no ordinary completion |

Add `ApprovalRejected` to P4's closed no-effect denial codes. Keep P4's
existing `ApprovalExpired`, `ApprovalNoLongerAuthorized`, `Interrupted`, and
`OutcomeUnknown` semantics. `ApprovalRequired` remains a nonterminal
handoff-only result and is never written as a terminal Denied invocation.

Stop and approval creation/decision must linearize through transaction commit
order. The Application StopExecution composition closes an unclaimed Pending
or Approved Executable approval as `Cancelled` and consumes its Inbox item in
the same transaction as the stop fact. This is a route-specific cleanup; it
does not consume P4's InvocationApproval or alter a Control approval. If the
P4 claim wins first, the existing P2/P4 stop rules apply. A stale lease cannot
write the cancellation, action result or Observation.

`Cancelled` is distinct from human Reject and time Expire. If governance
rejects adding that terminal state, the alternative is to leave the exact
request pending until its bounded TTL while the Execution is stopped, with all
decision commands rejecting because the Execution is no longer active. That
alternative avoids a state value but leaves a stale actionable Inbox item and
is not recommended.

## 5. Persistence, replay and migration

Reuse the existing unified `action_approvals` ledger with mandatory route
filters. Add the minimum fields required to bind an Executable request to the
exact `ToolInvocationId` and AgentLoopStep/LogicalAction identity, and add the
`Cancelled` terminal state if accepted. Keep exact arguments/digests,
Execution, principal, tool identity/version, target resource IDs, ControlBasis,
expiry and decision provenance. Add unique constraints so one exact logical
action has one active request and one ApprovalId cannot bind to two intents.

`Cancelled` needs its own cancellation time, actor and reason. Preserve any
prior human decision fields when an `Approved` row is cancelled; do not erase
the approval decision to satisfy the old state/check constraint. Update the
state/provenance checks so `Pending → Cancelled` has no human decision,
`Approved → Cancelled` retains the Approve decision plus cancellation fact, and
only `Consumed` has `consumed_by/consumed_at`. A cancellation records the
trusted StopExecution cause, not a simulated human Reject.

Pending row plus Inbox admission is one transaction. Human decision plus
Inbox consumption plus resolution event plus Command receipt is one
transaction. P4 claim plus approval consumption remains the already accepted
AH7-DG-03 transaction. Do not put an external effect inside any transaction.
All Worker-originated mutations use the complete P2 lease tuple and expiry in
the same transaction. External human decisions use their authenticated
Command authority and exact revision, not a Worker lease.

Crash/replay rules:

- crash before Pending+Inbox commit: neither exists; replay of the same pinned
  action creates one exact request;
- crash after commit but before pause/wake delivery: durable Pending suppresses
  scheduler dispatch; recovery rediscovers the same action and request;
- decision commit before consumer delivery: command receipt and resolution
  event survive; redelivery wakes the same Execution idempotently;
- crash before/after P4 claim commit: apply AH7 AP1/AP2 exactly; pre-commit
  leaves approval unused and no intent, post-commit binds both to the same
  ToolInvocationId;
- crash after effect admission: apply AH7 AP6/AP7 and P9 reconciliation;
  never infer no effect or replay NonIdempotent work;
- crash after ToolResult/Observation but before action/cursor commit: the P3
  transaction rolls back or sourced replay converges once; it cannot repeat
  the effect or advance the cursor twice.

Migration preserves the route split. Existing `Control` rows remain governed
by CAPA. Existing Executable approvals without a verifiable exact invocation
and Step binding are not matched to Session text, callRef guesses or a
Control approval; mark them expired/unusable as migration evidence. Historical
P4 denial rows remain terminal. Do not reinterpret any old
`Denied(ApprovalRequired)` as a pending request or resume it. They stay
terminal no-effect outcomes; a later attempt needs a new model action and a
new approval request.

## 6. Governance Inbox and browser contract

The Inbox key is `eap:<ApprovalId>:<revision>` and is parsed only as an
Executable approval target. The existing `cap:<ApprovalId>:<revision>` parser
continues to target Control approvals only. Same ID text cannot cross route
types; every endpoint also checks `route_kind`, project, workspace, execution,
revision and authenticated decision authority.

The Queue renders the exact tool name/version, a human-readable bounded view
of validated arguments, resolved resource targets, relevant capability and
effect semantics, the requesting Workspace/Execution, expiry, and the
immutable action digest. Runtime-generated summary text is not accepted as
authority. Schema-designated secrets are redacted while making the remaining
effect understandable; if the action cannot be reviewed precisely, fail
closed and do not offer Approve. Approve/Reject requires the exact displayed
revision and confirmation; after success the Inbox entry is consumed and the
decision cannot be changed by retry.

Approval content stays in Governance/Inbox history. It is not injected as
instructions into the Agent Session. The next model-visible fact is the
bounded typed ToolResult sourced to the same call after the AgentLoop resumes.

## 7. Alternatives and tradeoffs

| Option | Behavior | Tradeoff | Decision |
|---|---|---|---|
| A. Keep current fail-closed behavior | `requiresApproval=true` with no pre-issued approval becomes terminal P4 Denied; no human route | Smallest scope; no approved Executable handoff, and cannot meet the requested product behavior | Reject for this gap; retain as fallback for authority failure and unsupported routes |
| B. Reuse CAPA Control approval unchanged | Put Executable calls through `Control ActionApproval` and `ResolveControlApproval` | Conflates stable control identity/Command consumption with ToolInvocation identity; risks approving or consuming the wrong route and obscures P4's atomic claim | Reject; CAPA explicitly keeps Sandbox/Executable approval separate |
| C. Separate Executable lifecycle on existing approval ledger | Reuse exact `InvocationApproval`, `action_approvals`, Inbox and same-step wake; enforce `route_kind='Executable'`, exact invocation binding and separate decision command | Adds issuance, decision command, route-specific Inbox UI, exact binding and cancellation semantics; reuses existing durable machinery | **Recommend** |
| D. New standalone approval table and queue | Create separate store/table and browser surface | Strong isolation but duplicates lifecycle, expiry, dedup, decisions and recovery semantics | Reject for v1 unless physical-ledger constraints prevent route separation |

## 8. Security and invariants

1. Approval ID and every binding field are Runtime/Application-owned. No model
   output or external payload can construct an Executable approval fact.
2. P12 authorization must succeed before a Pending request is created; human
   approval cannot turn a missing/revoked PermissionGrant into authority.
3. Approval never widens capabilities, target resources, Sandbox mounts or
   ResourceBoundary. Current authorization is checked again at claim and
   effect admission.
4. Exact route, project, workspace, execution, AgentLoopStep, LogicalAction,
   ToolInvocationId, principal, tool/version, arguments, regions, ControlBasis
   and revision must all match. No route substitution or cross-execution use.
5. One approval can be consumed once and only by its bound ToolInvocationId.
   Approval decisions are one-way CAS transitions; duplicate delivery is
   idempotent.
6. Pending/Approved is not permission to start an effect. Only the accepted
   P4 effect-admission commit authorizes entering Sandbox/Executor.
7. `MayHaveStarted` never becomes a no-effect denial or a blind retry. Stop,
   lease loss and unknown outcome follow P2/P4/P9 recovery.
8. Untrusted tool arguments are displayed as data, escaped and schema-validated;
   they cannot alter decision controls, route identity, or approval authority.

## 9. Failure evidence and black-box qualification matrix

These are acceptance requirements, not test results. They must be exercised
after manual acceptance and implementation authorization. Store fixtures may
seed rows only in store-unit tests; no layer above Store may use seeded
approval as evidence of production issuance.

| Layer | Required black-box evidence |
|---|---|
| Store / migration | Pending row + Inbox dedup are atomic; exact route/binding and revision CAS; concurrent Approve/Reject has one winner; Expire/Cancel is idempotent; Executable consume accepts only exact bound ToolInvocationId; Control APIs cannot read/decide/consume Executable rows; legacy unbound rows fail closed. |
| P4 Runtime | Real `requiresApproval=true` with no approval returns nonterminal `ApprovalRequired` and makes zero ToolInvocation terminal Denied, Sandbox or Executor calls; wrong/expired/rejected approvals produce typed no-effect Denied; exact Approved record reaches fenced claim; authority revocation before/after claim follows accepted denial rules; exact replay never consumes twice. |
| P3 / AgentLoop | Provider ToolCall is pinned once; pause leaves same Execution/Step/action Pending and cursor fixed; Approve resumes the same ToolInvocationId and executes once; Reject/Expire creates one typed ToolResult, TerminalRejected and one cursor advance; later actions follow existing rules; no new Provider request is issued to recover the action. |
| Daemon / P2 / P9 process | Real daemon kill before/after Pending+Inbox commit; decision commit before wake; generation takeover; AP1/AP2 claim commit boundaries; stop races with pending, approved, claim and effect admission; after MayHaveStarted, exact side-effect recovery with no duplicate call. Assert full lease tuple, one approval decision, one consume, one effect/result/Observation and same Step/action identities. |
| Public API / Command | Exact `ResolveExecutableApproval` codec and authenticated authority; exact revision, route and active Execution; stale, foreign, malformed and Control IDs fail closed; receipt replay cannot double-decide or wake a second action. |
| Browser / Queue | Real Inbox entry becomes an Executable card from `eap:` only; displayed exact action/target matches persisted binding; Approve/Reject submits the displayed revision; success consumes the entry; stale/foreign IDs show typed not-found/conflict behavior; `cap:` remains Control-only. |
| End-to-end provider | A real model ToolCall requiring approval pauses with zero effect; browser Approve resumes the same Execution/Step/LogicalAction/ToolInvocationId and yields exactly one effect; repeat with Reject, Expire, grant revocation and Stop; restart at each durable boundary without another provider decision. |

Closure requires all layers, `pnpm check`, and the relevant functional/browser
journeys. AH7 L4 is specifically the process-crash qualification of P4/P2/P9
claim/effect/settlement boundaries. The L4 store-process test with a seeded
approval is necessary storage evidence but cannot substitute for production
issuance, public decision, Queue interaction, daemon wake or provider/AgentLoop
identity assertions above.

## 10. Owning contract updates after acceptance

No design file is authorized by this draft. If accepted, update only the
semantics in their owning contracts and retain this exact proposal, acceptance
record, proposal hash, owner revisions and independent landing review:

| Owner | Required contract landing |
|---|---|
| P4 | `01`/`02`/`03`/`06`: nonterminal approval handoff, exact ToolInvocation/Step binding, Executable route store/decision states, denial codes and unchanged AH7 fenced claim/effect boundaries |
| P3 | `08`: durable same-Step/action pause, result for Reject/Expire/Cancel, cursor and observation rules, Provider result replay and stop behavior |
| P12 | `02`: pure resolver production from trusted exact invocation input; no resolver persistence or consumption; issuer composition boundary |
| P1 / P6 | Command codec/authority/transaction and Inbox admission/consumption/event contracts for `ResolveExecutableApproval` and `eap:` target, separate from `ResolveControlApproval`/`cap:` |
| P17 / Web | approval-required Execution pause/resume and route-specific Queue projection/interaction |
| P2 / P9 | stop cancellation transaction ownership, lease/fencing, AP crash boundaries, exact same-action recovery and process qualification |

The manual governor should decide whether the one new `Cancelled` state and
the exact pre-consumption `ToolInvocationId` binding are accepted. They are
recommended because they preserve honest terminal semantics and prevent an
approved action from transferring to a different call.

## 11. Source evidence

Semantic baseline and failure evidence:

- `docs/design/implementation/P4/00-contract-index.md` — accepted AH7-DG-03
  route split and owner boundary.
- `docs/design/implementation/P4/01-tool-contracts.md`, `02-tool-runtime-pipeline.md`,
  `03-authority-permission-approval.md`, `06-invocation-persistence-reconciliation.md`
  — exact approval and pre-effect claim semantics.
- `docs/design/implementation/P2/03-lease-fencing-model.md` — complete lease
  tuple, expiry, stop ordering and same-transaction fencing.
- `docs/design/implementation/P3/08-agent-loop-step-handoff.md` — durable
  action ledger, same Provider result replay, Denied/Interrupted progression.
- `docs/design/implementation/P9/02-fault-injection-matrix.md` and
  `07-agent-loop-step-recovery.md` — AH7 approval claim/effect crash matrix.
- `docs/design/implementation/P12/02-authority-resolver.md` — pure
  `resolveApproval` output and no-I/O/no-mutation boundary.
- `docs/design/implementation/P17-conversation-delivery-runtime/04-turn-profile-resolver.md`
  and `07-acceptance.md` — CAPA approval pause/resolve contract for Control.
- `apps/single-workspace/src/executable-tool-handler.ts` — fixed null approval
  at the Executable production boundary.
- `packages/tool-runtime/src/runtime.ts` — per-intent approval predicate and
  fail-closed missing-ID behavior.
- `apps/single-workspace/src/control-action-authorizer.ts`,
  `packages/application/src/commands/resolve-control-approval.ts`,
  `apps/web/src/queue/governance-target.ts` — current Control-only Pending,
  decision and Queue path.
- `adapters/persistence-sqlite/src/migrations.ts` — unified approval ledger
  has `route_kind` and separate route identity; migration must preserve it.
- `planning/results/AH7-DG-03-governance-acceptance-and-landing.review.md` —
  accepted proposal digest, exact landing scope and decision provenance.

## 12. Acceptance token

```text
ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME
```

Acceptance authorizes exact owner-document landing only. It does not authorize
production implementation, migrations, test changes, push or merge; those
remain separately gated by the landed contracts and implementation plan.
