# S3 AnyProducer Settled-Wait Governance Proposal (Draft)

**Status:** DRAFT — not accepted; no production implementation authorized.

**Evidence:** Real public S3 rerun result
`planning/results/real-public-s3-collaboration-rerun-20261024.result.md`;
isolated RED `tests/functional/pending/s3-any-producer-settled-wait-attention.pending.test.ts`.

## Problem

The real S3 attempt produced an approved Parent Workspace and Parent Work. The
model declared an `AnyProducer` dependency, registered a durable
`DependencyChanged` WorkWait, then settled the Work execution. No Child,
producer Work, pending formation, or matching Deliverable existed. The Work
remained Open and waited indefinitely. Public Attention was empty; the
20-minute scenario deadline expired while the public tree remained unchanged.

This is distinct from the already-closed P7-GAP-01 case. Frozen P7 `05` defines
`AnyProducer` as a non-edge in the wait-for graph; frozen P10 `02` derives
`WaitingOnVacantProducer` only for `Unsatisfied ∧ WorkspaceBound` dependencies
whose exact producer Workspace has no Open Work and is not Retired. The current
state is outside both rules. Do not reinterpret this evidence as a projection
implementation defect.

## Proposal

Adopt the following single closed rule set. Keep `ProducerBinding.AnyProducer`
and P7 matching/satisfaction semantics unchanged; add only a model-action
eligibility check and a read-only legacy-state Attention derivation.

### APW-1 — Closed producer-evidence set for new model-authored waits

Before `DeclareDependency(AnyProducer)` may be executed by a model-authored
`AgentAction`, Runtime must first resolve the existing exact Action/Command
receipt. If that identity already has a committed or terminal outcome, replay
that immutable outcome without re-evaluating producer evidence. Only a new
action with no exact prior receipt is subject to the following evidence gate.
Runtime must find at least one of these exact same-Project facts in a single
canonical read snapshot:

1. **Other Open Work:** a Work other than the consumer Work whose lifecycle is
   `Open`. A Work's free-text objective is not capability evidence and MUST NOT
   be inspected to infer deliverable capability. `AnyProducer` retains its
   existing meaning: a produced Deliverable still has to pass the frozen P7
   matcher before satisfaction.
2. **Approved formation still materializing:** a FormationProposal at the
   exact approved revision whose P2 `FormationFulfillment` is in
   `PendingApplication` or `WorkspaceCreated` and has a non-null
   `expectedInitialWorkId`. `AwaitingDecision`, `Blocked`, `Applied`,
   `Pending`, `Modified`, `Rejected`, and stale proposals do not prove an
   authorized producer.
3. **Committed matching Deliverable awaiting coordinator convergence:** an
   already-persisted Deliverable in the same Project that passes the exact P7
   matcher for this new Dependency's `ExpectedDeliverable`. A `DependencyDeclared`
   event then triggers the existing deterministic coordinator to recheck that
   persisted candidate. Because this is pre-Declare eligibility, the new
   DependencyId and its satisfaction CommandId do not exist yet; this check
   MUST NOT guess or query a historical satisfaction receipt. Do not infer
   this case from an uncommitted Provider response or an Artifact without a
   Deliverable.

No other fact is producer evidence. In particular, a Message, Inbox entry,
unapproved proposal, other Project's Work/Deliverable, arbitrary future user
promise, or the consumer Work itself is insufficient.

If the closed set is empty, the `DeclareDependency` model action MUST return
the existing `AgentActionRejected` disposition `ModelUsable` with a stable,
safe reason code indicating that no producer evidence exists. The control
action MUST NOT submit a canonical `DeclareDependency` command, persist a
Command receipt, emit `DependencyDeclared`, or create a `WorkWait`. This is a
control/action rejection, not a Domain lifecycle error; the Dependency remains
absent. Rejection leaves the Provider decision repairable and does not create
a synthetic Dependency or claim it is Unfulfillable.

This precondition applies only to the new model-authored `AgentAction`; it does
not rewrite the P7 command contract or make `AnyProducer` a fixed binding.
Existing/human governance paths remain available where authorized.

### APW-2 — Explicit expression of intentional future sources

When a producer does not yet exist, do not encode the unknown future as an
unbounded model wait:

- For a known future Workspace, first use the existing Parent-governed
  formation path and exact human `RecordDecision`; after the Workspace exists,
  express the dependency as `WorkspaceBound(exactWorkspaceId)`. The existing
  P10 vacant-Workspace Attention then remains the visible signal if that
  Workspace has no Open Work.
- For information-only external input, use the existing exact Message/Inbox
  route and its durable wait condition; a Message is not a P7 Deliverable and
  cannot satisfy an Artifact dependency.
- If no authorized Workspace or public command can represent a future external
  Artifact producer, the model must request Parent/user clarification through
  existing governance. It must not treat an Inbox message or an uncommitted
  promise as a matching Deliverable.

This preserves the distinction between a known designated future producer and
an unspecified `AnyProducer` set.

### APW-3 — Legacy settled-wait Attention (derived only)

For already-persisted AnyProducer waits, add an on-read P10 Attention row only
when all the following canonical facts hold in one read snapshot:

1. The Dependency is `Unsatisfied`, its binding is `AnyProducer`, and the
   consumer Work has an active `DependencyChanged` WorkWait naming that exact
   Dependency whose `observedRevision` equals the Dependency's current
   revision.
2. The consumer Work is still `Open`, and no WorkEpisode execution for it is
   active.
3. For an existing dependency, the legacy producer-evidence predicate is
   APW-1 categories 1–2 plus a matching persisted Deliverable only if its exact
   deterministic P7 satisfaction command has no `Committed` or
   `TerminalRejected` receipt (a missing or retryable/nonterminal receipt may
   still converge). `Committed` satisfaction is terminal; an exact terminal
   rejection is not a convergence candidate and this proposal does not retry
   that deterministic CommandId. The legacy Attention exposes the unresolved
   condition for existing governance/revision handling.
4. No project Execution is active, there is no current `Pending`
   FormationProposal in the Project, and there is no Approved-but-unapplied
   formation fulfillment. These are the frozen `project idle / no authorized
   producer transition` predicates. A Pending proposal is not producer
   evidence, but suppresses the duplicate Attention while its existing
   Governance Inbox decision is actionable; if it is rejected/withdrawn, the
   derived Attention becomes visible again while the dependency remains
   waiting.

Project `Attention` MUST reuse the existing `WaitingOnVacantProducer` source
label, target the consumer Workspace, use the existing `vacant-producer:<dep>`
dedup family, and use a fixed non-content-bearing safe summary that does not
claim an exact producer Workspace. This row is read-only. It MUST NOT:

- change the Dependency, WorkWait, Work lifecycle, Project, or proposal;
- mark the Dependency `Unfulfillable` or clear the Wait;
- satisfy the Dependency, create a Deliverable, or wake the consumer;
- expose model/provider text, private Work objectives, or a newly invented
  action/command.

The derived row disappears automatically when any eligibility evidence
appears, the Dependency becomes terminal/satisfied, the exact WorkWait is
cleared, or the project ceases to satisfy the idle predicate. A brief row
between a legitimate P7 wake becoming due and the existing wake consumer
clearing the still-current Wait is allowed: the row is a read-only observation,
not authority or a wake/claim gate. A revision-mismatched Wait is always
suppressed by APW-3. Existing P7
coordinator satisfaction and `DependencyChanged` wake behavior remains the
only path that satisfies/wakes the Parent after a real matching Deliverable.

This legacy rule avoids converting a temporarily active producer search into
an Attention. APW-1 prevents new model-authored waits from entering the
unproven state, while APW-3 surfaces only already-durable waits that have
settled into a project-idle zero-producer condition.

## Ownership and compatibility

- P7 owns the model-action admission precondition and the closed producer
  evidence query; P7's matching, Dependency, WorkWait, Coordinator, and wake
  semantics remain unchanged.
- P10 owns the derived Attention projection and safe summary; reuse the
  existing source/wire DTO label. Do not add a source literal, HTTP route,
  migration, table, event, receipt namespace, wake reason, or persistent
  Attention marker.
- The exact eligibility read must be snapshot-consistent with the execution's
  Project/consumer Work and must not use Provider/Work objective text as
  evidence. Cross-Project evidence never counts.
- Docs/design remain untouched until this proposal is accepted. Acceptance
  must identify the owning P7/P10 contracts and be followed by a separate
  authorized implementation package.

## Required review and acceptance evidence

Before acceptance, independent review must confirm the three evidence cases
are complete and that the predicates are computable from current durable facts
without schema changes. A fixed RED/acceptance matrix must cover:

- no evidence: model action yields `AgentActionRejected/ModelUsable`, with no
  Command receipt, Dependency, `DependencyDeclared`, or WorkWait;
- each of the three positive evidence classes: action remains usable, but
  satisfaction still requires a real matcher-passing Deliverable;
- pre-existing settled AnyProducer wait with no evidence and idle Project:
  one workspace Attention row, unchanged canonical snapshot;
- active Project Execution, another Open Work, Approved-but-unapplied
  formation, or committed matching Deliverable: no vacant-wait Attention;
- stale WorkWait revision: no Attention; a current-revision Wait may briefly
  render Attention until its existing P7 wake consumer clears it;
- exact prior Action/Command receipt replay: replay unchanged even if producer
  evidence has since disappeared; a matching Deliverable with a terminal
  deterministic satisfaction receipt is not a convergence candidate;
- later producer evidence, matching delivery/coordinator satisfaction, and
  explicit Wait clear: deterministic disappearance; only real satisfaction
  clears/wakes the Parent;
- Pending/Rejected formation, cross-Project facts, consumer Work itself,
  Message-only evidence, and non-matching Deliverable: negative controls;
- migration/schema compatibility, restart/replay, deduplication, and public
  projection behavior; no real Provider qualification is implied by unit or
  process tests.

Until manual acceptance, this remains a design proposal and the RED remains
intentionally failing/excluded from normal test suites.
