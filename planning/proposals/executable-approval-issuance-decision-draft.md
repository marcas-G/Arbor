# Executable approval issuance/decision/resume

**Gap:** `EA-DG-01` — approved Executable handoff is not wired end to end

**Proposed decision:** `ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME`

**Status:** DRAFT / AWAITING MANUAL ACCEPTANCE

**Semantic baseline:** accepted AH7-DG-03 landing at `5cab270642f3a738f1da3dcb846ce734d477f8b2`; CAPA Control approval remains a separate route.

## 1. Decision requested

Close the human handoff for approval-required Executable tool calls under the
already accepted MAC shared `ActionApproval` lifecycle. Reuse the existing
exact `InvocationApproval`, unified `action_approvals` storage, Governance
Inbox projection and P3 same-step resume machinery, while keeping the
`Executable` and `Control` routes strictly distinct. This is a MAC/P4/P3/P1/
P6/P10/P12/P17/DID owner-contract closure, not a second approval architecture.

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
   currently writes P4 no-effect `Denied(ApprovalRequired)`; it is not a
   pending human interruption. Under this proposal that code is retained for
   historical row decoding/replay only. New writes return the nonterminal
   `ApprovalRequired` pause and cannot close the action as Denied.
3. `packages/application/src/authority-resolver.ts` exports
   `resolveApproval`, but it is a pure fact producer. The P12 contract says
   `R = never`, and the function itself creates no durable row or Inbox entry.
   There is no production call site that issues this fact.
4. The production Pending/Inbox writer is
   `apps/single-workspace/src/control-action-authorizer.ts`; it creates
   `route_kind = 'Control'` and `cap:<id>:<revision>`. The Web parser and
   `ResolveControlApproval` command accept that Control route only. They do
   not create an Executable `InvocationApproval`.
5. Existing `Denied(ApprovalRequired)` rows follow their stored terminal
   outcome under P3 and remain terminal on replay. New `requiresApproval=true`
   calls must leave the action Pending, keep its cursor fixed and resume that
   same action after decision; otherwise the P3 contract and MAC typed
   `ApprovalRequired` pause cannot be satisfied.

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

The ApprovalId is generated by Runtime from trusted route identity and the
exact action key, so replay of the same pinned action converges on the same
row. It must not be derived from model-supplied approval data. Before minting
an ID or evaluating a fresh TTL, issuance first looks up the committed request
by `(projectId, executionId, AgentLoopStepIdentity, LogicalActionId, callRef,
ToolInvocationId)`. An exact existing row returns its original ApprovalId,
revision and `expiresAt`; a changed binding for that action key is a durable
invariant conflict. Only an absent key can create a request and start its TTL.
Concurrent first issuers race through a unique logical-action key; the loser
reads and verifies the committed winner. The store retains the exact validated
arguments needed to verify the action digest; queue text is not the authority
source.

The accepted P4 `InvocationApproval` fields remain authoritative. Amend that
record and the Executable approval row with the exact
`toolInvocationId`/AgentLoopStep/LogicalAction/callRef binding; do not infer
this binding later from Session text, a Control approval, or a matching
argument string. The P12 pure `resolveApproval` input and output include this
Runtime-owned identity so its derived ApprovalId stays stable across a replay
with a later wall-clock `now`. The Application checks the request key before
calling the resolver again; for an existing row, stored `expiresAt` is
authoritative and a new `now` never extends it.
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
3. confirm that the bound AgentLoopStep action is the same Pending action;
4. append the durable `ExecutableApprovalRequested` fact and P2 wake source.

Repeated issuance with the same exact binding is idempotent and preserves the
first committed `expiresAt`; Provider replay, daemon restart and duplicate
Inbox delivery do not extend TTL. Reusing the same ApprovalId or logical-action
key with any different binding is an invariant conflict and fails closed. The
Inbox row is not promoted into an Agent Session.

The existing `ExecutionDriveOutcome.ApprovalRequired` carries the typed pause;
the committed exact Pending row is its durable source. The Execution remains
Active, no Execution settlement is written,
the AgentLoopStep remains at `ActionsInProgress`, the same action stays
Pending, and the current lease is released. The daemon does not poll/replay an
Execution while an exact Executable approval is Pending. The approval row and
Inbox entry are the durable reason for this pause; no new Provider request is
permitted to reconstruct the action.

### 3.3 Human decision and wake

Add an External human command `ResolveExecutableApproval` with the exact
ApprovalId, expected revision, and `Approve | Reject` decision. It is a
separate registered route from `ResolveControlApproval`; its authority fact,
codec, handler and queue parser cannot accept Control IDs or evidence. P12
resolves a typed decision authority from the authenticated human, project,
workspace, bound Execution and policy. A `user:` string alone is not
authority. Missing and foreign targets return the same non-disclosing
not-found result; an authorized target with a stale revision returns a typed
revision conflict. The command gateway validates route, authority, expiry and
revision before committing a decision or revealing a prior receipt.

The command transaction:

- loads only an Executable approval in the requested project/workspace;
- verifies the bound Execution is still active and the exact revision is
  Pending. If `expiresAt <= now`, it commits Expired instead of applying the
  requested human decision; otherwise it applies the requested decision;
- compare-and-sets the exact state/revision and increments once; Approve/Reject
  records the authenticated human and decision time, while the expiry branch
  records no human decision; both consume the exact Inbox entry if unconsumed;
- appends `ExecutableApprovalResolved` with exact approval/route/revision and
  decision, and commits the command receipt atomically. Expire and Cancel use
  the same fact with a typed cause and commit their durable P2 wake source in
  the same transaction.

The command result returns the committed state and new revision, including
`Expired` when the deadline wins the decision race. A same CommandId replay
returns that same receipt; a different command with the old revision receives
the typed stale-revision result.

After commit, a resolved-approval consumer wakes the same Execution. Approve,
Reject and Expire all wake that same execution because the action must receive
a typed terminal outcome or resume; none creates a new Execution, Step,
ProviderTurn or action identity. The same settled Provider result is replayed
locally. On Approve, the Executable handler passes the Runtime-selected
ApprovalId and exact Approved row revision with the same ToolInvocationId
into P4; the mutable revision is a CAS token, not part of the immutable action
binding. On Reject or Expire, P4 records a fenced no-effect Denied settlement
for that same ToolInvocationId with `effect_admission_state=NotAdmitted` and
the exact ApprovalId; no Sandbox/Executor call occurs. The action receives a
typed denied ToolResult, becomes `TerminalRejected`, writes its sourced
Observation and advances the cursor exactly once.

Expiration is deterministic at `expiresAt`: the command boundary or
daemon/sweeper performs a revision-checked
`Pending | Approved → Expired` transition, consumes the exact
unconsumed Inbox entry if present, appends a durable approval-resolution fact,
and creates the same durable P2 wake source in that transaction. The fact is
the recovery truth if the process crashes before publishing a wake signal; the
consumer resumes it idempotently after restart. Decision after expiry is a
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
ToolInvocationId with `state='Approved'` and the exact Approved revision. P4
rechecks authority, approval binding, stop state and the
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

Add `ApprovalRejected` to P4's closed no-effect denial codes. For new writes,
the closed `NoEffectDenialCode` excludes `ApprovalRequired`; retain a separate
legacy decoder/read union that accepts historical
`Denied(ApprovalRequired)` rows. Keep P4's existing `ApprovalExpired`,
`ApprovalNoLongerAuthorized`, `Interrupted`, and `OutcomeUnknown` semantics.
`ApprovalRequired` is a nonterminal ActionResult/Execution handoff and is never
written as a new terminal Denied invocation.

The new-write set is the accepted AH7-DG-03 `NoEffectDenialCode` set with
`ApprovalRequired` removed and `ApprovalRejected` added. The persisted-row
decoder accepts `NoEffectDenialCode | LegacyNoEffectDenialCode`, where
`LegacyNoEffectDenialCode = 'ApprovalRequired'`; only the decoder/replay path
may construct that legacy case. Migration preserves old rows byte-for-byte and
does not reinterpret or backfill them as Pending approvals.

Approval issuance is a Worker-originated mutation: the transaction that adds
the Pending row and admits Inbox verifies the full live P2 lease-holder tuple,
lease expiry, active Execution, `stop_requested_at IS NULL`, and the exact
still-Pending Step/action. Stop and issuance linearize at that transaction
boundary: Stop first yields `ExecutionStopping` with no approval/Inbox row;
issuance first yields one request that the Stop transaction must close.

The Application StopExecution composition validates the authorized P2 Stop
command and atomically commits `stop_requested_at`, closes an unclaimed
Pending or Approved Executable approval as `Cancelled`, marks its exact Inbox
item consumed, appends the durable cancellation fact and publishes the durable
Execution wake source. The stop command itself uses P2's human/command
authority, not a Worker lease; any Worker-originated cancellation or follow-up
write still carries the full current lease tuple and expiry. No stale Worker
may cancel, append an action result or Observation. This route-specific
cleanup does not consume P4's InvocationApproval and leaves all Control rows
and Control stop behavior unchanged. If the P4 claim wins first, accepted P2/
P4 stop rules apply.

`Cancelled` is distinct from human Reject and time Expire. If governance
rejects adding that terminal state, the alternative is to leave the exact
request pending until its bounded TTL while the Execution is stopped, with all
decision commands rejecting because the Execution is no longer active. That
alternative avoids a state value but leaves a stale actionable Inbox item and
is not recommended.

## 5. Persistence, replay and migration

Reuse the existing unified `action_approvals` ledger with mandatory route
filters. Add the minimum fields required to bind an Executable request to the
exact `ToolInvocationId`, AgentLoopStep, LogicalActionId and callRef, and add
the `Cancelled` terminal state. Keep exact arguments/digests, Execution,
principal, tool identity/version, target resource IDs, ControlBasis, expiry
and decision provenance. Rebuild the DDL state CHECKs so each state has
consistent decision, consumption and cancellation provenance: `Cancelled`
may preserve a prior human Approve decision, but never claims consumption;
only `Consumed` has both `consumed_by` and `consumed_at`, and they are either
both present or both absent.

Add the Step key fields `logical_step_no`, `repair_attempt` and `action_index`
used by the unique index below. The approval `revision` remains a mutable
compare-and-set state revision; it is separate from the immutable exact-action
binding and is returned to the handler for the P4 claim.

The DDL requires `project_id`, `workspace_id`, `execution_id`, Step identity,
LogicalActionId, callRef and ToolInvocationId on new Executable rows. Control
rows keep their route-owned shape; nullable Executable identity fields cannot
be used to bypass the new partial unique index.

Migration 0032's current
`action_approvals_exact_action(route_kind, execution_id, action_digest,
control_basis_digest)` unique index blocks two different LogicalActions in one
Execution from requesting approval for the same semantic action. Replace it
with route-specific uniqueness:

```sql
DROP INDEX action_approvals_exact_action;

-- Preserve the current exact-action uniqueness for Control rows.
CREATE UNIQUE INDEX action_approvals_control_exact_action
  ON action_approvals(execution_id, action_digest, control_basis_digest)
  WHERE route_kind = 'Control' AND execution_id IS NOT NULL;

-- Deduplicate Executable requests by logical action, not semantic digest.
CREATE UNIQUE INDEX action_approvals_executable_logical_action
  ON action_approvals(execution_id, logical_step_no, repair_attempt,
                      action_index, logical_action_id)
  WHERE route_kind = 'Executable' AND execution_id IS NOT NULL;
```

The full stored tuple still includes step identity, callRef,
ToolInvocationId and action digest; the issuer compares every member after a
unique-key conflict. Same Execution + different LogicalActionId may request
approval for the same tool/arguments/ControlBasis, each with its own ApprovalId
and TTL. Same LogicalActionId + changed tuple is an invariant conflict, never
a second approval. Existing Control uniqueness and route handling remain
unchanged.

`Cancelled` needs its own cancellation time, actor and reason. Preserve any
prior human decision fields when an `Approved` row is cancelled; do not erase
the approval decision to satisfy the old state/check constraint. Update the
state/provenance checks so Pending → Cancelled has no human decision,
Approved → Cancelled retains the Approve decision plus cancellation fact, and
only `Consumed` has both `consumed_by/consumed_at`. `Expired` may likewise
retain the human Approve decision when expiry follows approval, while an
expired Pending row has no decision. The DDL requires both decision timestamp
and actor for human Approved/Rejected states, preserves both when a later
Expired/Cancelled state follows Approve, and rejects either field by itself.
A cancellation records the trusted StopExecution cause, not a simulated human
Reject.

Pending row plus Inbox admission plus exact Worker fence/stop check is one
transaction. Human decision plus Inbox consumption plus resolution event plus
Command receipt is one transaction under P12-resolved human decision
authority. Expire plus Inbox consumption, durable resolution fact and P2 wake
source is one transaction. Stop plus Executable approval cancellation, Inbox
consumption, durable cancellation fact and P2 wake source is one transaction
under the authorized P2 Stop command. Any Worker-originated mutation in these
paths uses the complete current P2 lease tuple and expiry in the same
transaction. External human decision/Stop commands use authenticated P12/P2
authority and exact revision/state, not a Worker lease. P4 claim plus approval
consumption remains the already accepted AH7-DG-03 transaction. Do not put an
external effect inside any transaction.

Crash/replay rules:

- crash before Pending+Inbox commit: neither exists; replay of the same pinned
  action creates one exact request;
- retry before or after the stored TTL: exact-action lookup returns the same
  ApprovalId and original `expiresAt`; it never renews TTL. A different
  LogicalActionId with identical semantic arguments gets a distinct request;
- crash after commit but before pause/wake delivery: durable Pending suppresses
  scheduler dispatch; recovery rediscovers the same action and request;
- decision commit before consumer delivery: command receipt and resolution
  event survive; redelivery wakes the same Execution idempotently;
- expiry/Stop commit before wake delivery: terminal approval state, Inbox
  consumption and durable wake fact survive; restart redelivers the same wake;
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
| A. Keep current fail-closed behavior | New `requiresApproval=true` with no pre-issued approval becomes terminal P4 Denied; old Denied rows stay replayable | Smallest scope; no approved Executable handoff, and cannot meet the requested product behavior | Reject for this gap; terminal denial remains valid for actual authority/approval rejection |
| B. Reuse CAPA Control approval unchanged | Put Executable calls through `Control ActionApproval` and `ResolveControlApproval` | Conflates stable control identity/Command consumption with ToolInvocation identity; risks approving or consuming the wrong route and obscures P4's atomic claim | Reject; CAPA explicitly keeps Sandbox/Executable approval separate |
| C. Executable issuance/decision on the shared lifecycle | Reuse exact `InvocationApproval`, `action_approvals`, Inbox and same-step wake; enforce `route_kind='Executable'`, exact invocation binding and separate decision command | Adds issuance, decision command, route-specific Inbox UI, exact binding and cancellation semantics; reuses existing durable machinery | **Recommend** |
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
| Store / migration | Rebuild DDL CHECKs for `Cancelled` and provenance; test Pending/Approved → Cancelled while preserving any human decision; prove Pending+Inbox, expiry+Inbox-consumption+resolution fact+wake, and Stop+Cancel+Inbox-consumption+resolution fact+wake are atomic. Replace 0032's digest-only uniqueness: same Execution + different LogicalActionId + same digest creates two rows, while replay of one action reuses the exact row/TTL and changed binding fails. Retain Control exact-action uniqueness and prove route isolation. Executable consume accepts only its bound ToolInvocationId. Legacy unbound rows and old `Denied(ApprovalRequired)` replay fail closed and are never promoted. |
| P4 Runtime | New `requiresApproval=true` with no approved record returns nonterminal `ApprovalRequired`, writes no terminal `Denied(ApprovalRequired)` and makes zero Sandbox/Executor calls. Existing `Denied(ApprovalRequired)` replays as its historical terminal result. Reject maps to new closed `ApprovalRejected`; Expire maps to `ApprovalExpired`; wrong/mismatched IDs deny. Authority revoke before claim remains unconsumed; revoke after claim/before admission yields `ApprovalNoLongerAuthorized`; stop before claim yields Interrupted; stop/external effect after `MayHaveStarted` follows AP6/AP7. Every branch has one typed ToolResult/cursor progression and never calls an unauthorized effect. |
| P3 / AgentLoop | Provider ToolCall is pinned once; issuance lookup by Runtime-owned Step/LogicalAction/callRef/ToolInvocationId returns existing expiry; pause leaves same Execution/Step/action Pending and cursor fixed. Approve resumes that identity and executes once. Reject/Expire/Cancel/revoke/Stop each yields its prescribed typed result, TerminalRejected or Interrupted, and exactly one cursor advance; later actions follow the frozen early-settlement rule. No new Provider request reconstructs or changes the action. |
| Daemon / P2 / P9 process | Real daemon kills before/after issuance, Stop/cancel, expiry, decision and wake commits; prove commit-order race between issuance and Stop with the full lease tuple. Prove durable expiry/cancel/decision facts redeliver the same P2 wake after restart; old-generation writes fail. Cover AP1/AP2 claim commits, AP3 terminal no-effect commits, AP4/AP5 stop before/after claim, AP6 stop/effect-admission race, AP7 kill after `MayHaveStarted` and AP8 stale generation. Inject external effect completed but settlement absent for ReadOnly/Idempotent/Reconcilable/NonIdempotent; assert side-effect semantics, no unsafe duplicate and same invocation recovery. |
| Public API / Command | Exact `ResolveExecutableApproval` codec and P12-resolved human decision authority; authenticated but unauthorized human denied; missing and foreign target have identical non-disclosing NotFound; authorized stale revision gives typed conflict; expired, stopped Execution, malformed, Control-route and wrong-project/workspace requests cannot decide. Command receipt replay cannot double-decide or wake a second action. Stop command validates P2 authority and atomically closes the Executable approval without touching Control rows. |
| P6 Inbox / P10 Query / Browser | P6 admission upserts one `eap:` entry; consumption removes that exact revision from unconsumed Inbox. P10 Inbox view/query returns the safe Executable card only to its workspace and never writes. Browser renders exact action/target/revision and expiry; Approve/Reject targets `eap:` only; consumed entries disappear; stale/foreign items use safe responses; `cap:` remains Control-only. Restart/rebuild does not duplicate an item or resurrect consumed entries. |
| End-to-end provider | A real model ToolCall requiring approval pauses with zero effect; browser Approve resumes the same Execution/Step/LogicalAction/ToolInvocationId and yields exactly one effect. Repeat on separate actions for Reject, TTL Expire, pre-request and post-approval grant revocation, Stop while Pending, Stop while Approved, Stop after claim, and kill after external effect before settlement. Verify no request identity/TTL drift, no duplicate provider decision, no cross-route acceptance, and exact legacy replay behavior. |

Closure requires all layers, `pnpm check`, and the relevant functional/browser
journeys. AH7 L4 is specifically the process-crash qualification of P4/P2/P9
claim/effect/settlement boundaries. The L4 store-process test with a seeded
approval is necessary storage evidence but cannot substitute for production
issuance, public decision authority, P6/P10 Inbox behavior, daemon wake or
provider/AgentLoop identity assertions above. Exercise AP1–AP8 with the
production approval issuer and persisted request; add real kill/restart at
Pending admission, exact human decision, durable Expire/Cancel wake, and
external effect/result/settlement boundaries. No seeded approval counts as
proof above Store.

## 10. Owning contract updates after acceptance

No design file is authorized by this draft. If accepted, update only the
semantics in their owning contracts and retain this exact proposal, acceptance
record, proposal hash, owner revisions and independent landing review:

| Owner | Required contract landing |
|---|---|
| DID / SD | DID §6A.7/§7.6 and owning cross-layer tables: shared ActionResult/ActionDisposition distinguishes nonterminal `ApprovalRequired` pause from terminal no-effect `Denied`; new-write rule vs legacy replay is normative. SD authority/approval boundary states approval never grants PermissionGrant or widens Sandbox/ResourceBoundary. |
| MAC | `02-action-approval-error-boundary.md` adds `Cancelled`, exact Runtime-owned Step/LogicalAction/ToolInvocation binding, dedup identity, immutable TTL, legacy `Denied(ApprovalRequired)` read/replay, and common `ApprovalRequired` pause disposition. `00-contract-index.md` lists the amended lifecycle and typed result contract. Control and Executable remain route-specific. |
| P4 | `01`/`02`/`03`/`06`: nonterminal approval handoff, exact ToolInvocation/Step binding, new-write denial union plus legacy decoder, `ApprovalRejected`, Executable route store/decision states, 0032 unique-index replacement, DDL provenance checks and unchanged AH7 fenced claim/effect boundaries. |
| P3 | `08`: durable same-Step/action pause, result for Reject/Expire/Cancel/revocation/Stop, cursor and Observation rules, Provider result replay and no-new-turn behavior. |
| P1 | `01`/`02`/`03` and external codec/event contracts: `ResolveExecutableApproval`, exact decision authority, typed stale/foreign outcomes, command receipt, event and atomic decision transaction. P1 Stop transaction composes P2 stop with Executable approval cancellation; Control route is untouched. |
| P6 | `02`/`00`: `eap:` upsert-by-key admission, exact-revision consumption, no Session promotion, durable resolution wake signal source and route isolation from `cap:`. |
| P10 | `01`/`05`/`00`: Inbox projection/query includes safe exact Executable approval details, workspace isolation, consumed/expired view semantics and no write path. |
| P12 | `02`/`10`: pure approval fact now binds trusted Step/LogicalAction/callRef/ToolInvocation identity and stable request ID; pure `ResolveExecutableApproval` decision authority from authenticated human facts; persistence remains Application-owned. |
| P17 | `03`/`04`/`05`/`06`/`07`: same Execution/AgentLoopStep wake after approve/reject/expire/cancel, resolved-request polling/recovery and durable wake facts; no new ProviderTurn. |
| P2 / P9 | stop/lease composition, cancellation race, full lease fencing, AP1–AP8 plus approval issuance/decision/expiry/cancel wake and external-effect crash qualification. |

The manual governor should decide the `Cancelled` state, the exact
pre-consumption ToolInvocation binding, immutable first-commit TTL, and the
route-specific replacement for migration 0032's digest-only unique index.
These retain the already accepted shared approval lifecycle while allowing
distinct logical actions to request the same semantic action independently.

## 11. Source evidence

Semantic baseline and failure evidence:

- `docs/design/implementation/MAC/02-action-approval-error-boundary.md` and
  `00-contract-index.md` — shared ActionApproval lifecycle, separate routes,
  common `ApprovalRequired` ActionResult disposition and legacy isolation.
- `docs/design/02-system-design.md` §6.5/§8 and
  `docs/design/03-detailed-implementation-design.md` §6A.7/§7.6 — common
  effect/approval semantics and model-visible result disposition.
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
- `docs/design/implementation/P1/01-command-contracts.md`,
  `02-port-contracts.md`, `03-transaction-model.md` — external command
  authority, receipt replay, event and same-transaction boundary.
- `docs/design/implementation/P6/02-communication-protocol.md` and
  `00-contract-index.md` — Inbox upsert-by-key admission, consumption, wake
  source and no promotion assumptions.
- `docs/design/implementation/P10/01-view-inventory.md`,
  `05-surface-actions-transport.md`, `00-contract-index.md` — Inbox query/view
  ownership, safe projection and transport separation.
- `docs/design/implementation/P17-conversation-delivery-runtime/04-turn-profile-resolver.md`
  plus `03-recovery-scheduler-breaker.md`, `05-commands-projections.md`, and
  `07-acceptance.md` — CAPA approval pause, durable same-Execution wake and
  recovery contracts for Control.
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
