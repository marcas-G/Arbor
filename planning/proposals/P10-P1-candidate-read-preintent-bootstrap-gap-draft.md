# P10 CandidateRead Pre-Intent Bootstrap Gap — Governance Draft

Status: **DRAFT — NOT ACCEPTED; NO IMPLEMENTATION AUTHORIZATION**

## Decision requested

Decide whether P4's sandbox-policy requirement may be materialized from an
already persisted, exact P3 executable Action before P4 creates its
ToolInvocation/RecoveryBinding intent. The current candidate-read path is
bootstrapped only by a P4 `NotAdmitted` requirement. A first action therefore
cannot have a current OS policy until after it has entered P4; if it resumes
under an unavailable provider, P9 correctly terminates that action/Step and
does not create a later ProviderTurn/action. The accepted V6-E two-action
qualification sequence cannot be reached without a pre-intent candidate
source or a design change to the P9 terminal semantics.

This draft is narrowly about resolving the CandidateRead bootstrap circularity.
Option A does not by itself close the separately requested V6-E
second-ProviderTurn/drift qualification: a real P9 unavailable outcome is
terminal for the current action/Step. This draft changes no frozen contract
and authorizes no code. It requests an owner decision among the alternatives
below.

## Evidence and frozen-contract boundary

The Option A V6-E public-flow reproduction is in
`tests/functional/process/sandbox-policy-v6-registry-drift-restart.functional.test.ts`
on the isolated Option A implementation branch. It uses the public
`workspace-detail` candidate read after a P4 NotAdmitted intent; it does not
call `buildSandboxPolicyCandidateReadV2` or any pure producer to manufacture a
payload. With a real schema-50 database and the production P5 V3 source,
high-water and signed-evidence verifier, the observed sequence is:

1. A shell Action is persisted by P3 and reaches the P4 intent boundary as
   `NotAdmitted`; only then does the public P10 view expose
   `sandboxPolicyCandidateRead`.
2. The human commits exact P1 `OsEnforced` selection from that public read.
   The committed result contains the selected Supported tuple
   `windows-restricted-appcontainer-job / t3d-v1 / capabilityRevision 4`.
3. After restart, P4 resumes the same invocation/RecoveryBinding. The current
   Windows implementation remains Experimental, so no provider/helper is run.
   Its probe is `ProviderVersionMismatch`; P4 returns a typed no-effect
   unavailable outcome bound to the P1 tuple and actual probe evidence ref
   (`sha256:<64 lowercase hex>` from the Experimental capability probe).
4. P9 records the immutable fact, P10 queue row and wake event atomically,
   terminalizes that P3 action and Step, and returns `RecoveryBlocked`.
   DID P4/06 explicitly says this path ends the action/Step and that no later
   action occurs. Thus it cannot produce the second ProviderTurn/action
   needed to exercise fresh-policy intent and post-intent registry drift.

The same reproduction earlier exposed an implementation defect: the P4
unavailable outcome copied the mismatched observed version/capability revision
over the decision tuple, so the P9 exact-current-decision check rejected it.
That defect is fixed separately at commit
`cf165fd5b8523d6d13e17c1cb2406b14914709fc`; the fix preserves the P1 tuple,
the `ProviderVersionMismatch` failure code and the actual probe evidence ref.
It does not change P9's terminal/no-later-action semantics. After rebuilding
production `dist`, the focused V6-E reproduction passes 1/1 through P9's
terminal action/Step, immutable fact/queue, and bounded no-successor check; it
does not reach second-action registry-drift qualification. See
`planning/results/P10-P1-option-a-stage-e.result.md` for the exact command and
gates.

Relevant frozen contracts:

- P4/04: current exact decision and NotAdmitted interruption ordering.
- P4/06: P9 provider-unavailable terminal action/Step; no later action.
- P4/06 V5 requirement read port: P10 candidate read consumes a P4
  NotAdmitted requirement under the caller's transaction and does not mutate
  P3/P4 state.
- P10/05 and P10/07: public candidate is an exact read model, and P1 commits
  only its explicit provider/version/capability selector.
- P1/03: decision freshness and exact source revisions are rechecked at the
  V21 transaction linearization point.

## Option A — P3 action-bound pre-intent requirement (recommended)

Add a closed P4 requirement variant whose producer is the exact persisted P3
executable Action before the first P4 invocation intent. P4/Application may
materialize it only when all of the following are current and uniquely
proven:

- the active Execution and exact ExecutionEpisodeBinding;
- the P3 ProviderTurn/LogicalStep/LogicalAction/actionIndex/callRef and exact
  Pending executable Action revision;
- the exact tool identity and resource TargetRefs/access derived through the
  existing P11 resolver and current ResourceBoundary;
- an exact executable approval is present in the expected unconsumed state,
  bound to that same P3 action; no approval is created, widened, consumed or
  bypassed by candidate projection;
- current P5 authority/operator/provider snapshot and all existing workspace,
  boundary, bundle, registry and handle-binding preconditions.

P10 exposes the same canonical candidate DTO from this requirement. The human
may commit P1 against the exact requirement digest/action revision first, then
resolve/consume the existing executable approval. P4 creates its normal
NotAdmitted intent only after approval and reads the fresh P1 decision. It
does not rebind the P3 action or synthesize an invocation/binding early.

The P1 command payload remains the accepted Option A wire schema; the human
does not send a candidate ID, P3 action identity, approval identity, or source
digest. Outside the transaction, P1 preparation must uniquely resolve the
current active Execution/Episode, the next Pending executable Action and its
unconsumed approval. It builds an internal requirement-source proof from
those exact rows and the P11/P5 facts. Inside P1's existing receipt-first,
`BEGIN IMMEDIATE` linearization transaction, the current-preconditions/CAS
reader must re-read the same Action identity and revision, approval identity,
revision and unconsumed state, Execution/Episode, boundary and authority
references. No filesystem probe or new transaction is permitted inside this
CAS read.

For an already committed identical CommandId, receipt-first replay returns
the original receipt before consulting changed requirements, preserving P1's
existing replay semantics. A fresh CommandId whose prepared source proof has
gone stale commits the existing durable `StaleSandboxPolicyInputs` result and
no decision/event. Missing, duplicate or ambiguous Action/approval sources
fail closed before candidate publication; they are never chosen by ordering.
The requirement itself is a read-only derived proof, not a new approval or
durable command.

Required qualification: crash before and after the pre-intent requirement is
observable; public P10 CandidateRead before P4 intent; stale/replay and
concurrent P3 action/approval changes; decision commit before approval
consumption; first P4 intent after decision and approval; exact V6-E restart
drift sequence; zero ToolInvocation, RecoveryBinding, provider call, effect,
observation or settlement before P4's normal intent/effect gates.

Benefits: preserves P9's immutable terminal semantics, keeps P1 scoped to a
real admitted action, and allows the public operator to choose a policy before
the approval is consumed. It resolves only the bootstrap timing problem; it
does not make a P9-terminal Action produce a later ProviderTurn. Cost: adds an
explicit P4 requirement producer and CAS material to the P1 preparation/
commit path; P10's read port must handle both pre-intent and existing
NotAdmitted requirement variants without weakening either.

## Option B — proactive Workspace candidate (not preferred)

Expose a policy candidate for an active Execution/Workspace before any P3
executable Action requirement exists. P1 still requires a live Execution,
episode, boundary and authority snapshot, but no exact Pending Action is the
cause of the candidate.

This may bootstrap policy before the first model action, but it weakens the
current rule that candidate reads are caused by exact executable intent and
risks presenting OS-policy controls in unrelated/no-tool Work. It also needs
an owner decision on how an unbound decision is consumed, how the first later
Action's TargetRefs are constrained by it, and how stale/expiry is surfaced.
Do not infer that Workspace membership alone authorizes a provider candidate.

## Option C — let P9 unavailable actions continue to a later ProviderTurn (reject)

Change P9 so a typed provider-unavailable Action can be terminally recorded
and then allow the AgentLoopStep/Execution to continue or issue another
ProviderTurn. This would make the current late CandidateRead source capable
of reaching a later action, but changes the accepted P4/06 P9 terminal/no-later
action contract and broadens recovery after a provider failure. It risks
repeated model requests while the same exact policy/provider remains
unavailable and changes the meaning of P9 Attention. This option is not
recommended; it requires explicit governance and a new failure/retry bound,
not an implementation workaround.

## Cross-cutting consequences and required owner answers

| Area | Option A | Option B | Option C |
|---|---|---|---|
| Wire / command identity | Keep the accepted P1 wire schema and semantic request fingerprint. Client sends no candidate/action/approval ID. P1 preparation resolves one exact source proof, final CAS re-reads it; same CommandId replays its original receipt before source reads, fresh stale requests use the existing durable stale result. | Existing P1 wire may remain, but decision is not action-bound; define binding and replay explicitly. | No P1 wire change, but P9/P3 progression semantics change. |
| P10 / Web | Same CandidateRead DTO; expose it once an exact Pending Action + approval source exists. Web maps the selected provider/version/capability pair unchanged. | Candidate appears for active Work without an action requirement; Web visibility/product semantics change. | Candidate stays late; Web unchanged. |
| P1 CAS / stale | Preparation source proof is rechecked in P1's existing transaction against exact P3 Action revision, episode, approval state/revision and current V3/P5/P11 facts. Receipt-first replay remains unchanged; fresh stale requests are durable, no decision. | CAS rechecks execution/boundary but has no exact action/approval source. | Existing P1 CAS unchanged; P3/P9 progression needs new durable CAS/receipt rules. |
| P5 / migration / replay | No P5 registry schema or P1 decision row migration expected; new internal requirement codec/version and replay behavior need fixed canonical encoding/KAT. Existing committed decision/result receipts replay verbatim. | Likely no P5 migration, but define workspace-scoped vs execution-scoped decisions and candidate invalidation. | P9 action/Step and successor persistence semantics change; migration/replay/attention consequences require design. |
| Crash / concurrency | Requirement is derived/read-only. Before first P4 intent, restart recomputes from exact P3 facts. P1 commit uses current-transaction CAS. Concurrent action/approval consumption makes P1 stale. | Recompute workspace candidate; define behavior if no action arrives or boundary changes. | Must prove no duplicate turn/Action after restart and bounded unavailable retries. |
| V6-E | Enables public CandidateRead → P1 → approval → first P4 intent. It does **not** enable a later ProviderTurn after a P9 provider-unavailable terminal Action; fresh-policy intent/drift/restart remains a separate qualification question. | Can preselect policy, but qualification no longer proves an action-scoped candidate. | Could reuse current late read but conflicts with frozen P9. |

## Explicit non-goals

- No pure producer/test helper may manufacture the P1 payload in place of the
  public P10 candidate read.
- Do not mark any Windows tuple T3 Supported because of synthetic test
  fixtures, and do not run a native provider/helper.
- Do not relax Supported/current-host/V3 verifier requirements, P1 expected
  providerVersion/capabilityRevision matching, P9 fact identity, or P4
  approval/intent ordering.
- Do not persist host paths, actual probe diagnostics, or extra provider
  tuple fields in P9 facts.
- Do not modify `docs/design/**` until a manual owner decision accepts a fixed
  package.

## Requested acceptance

Choose Option A for bootstrap only, Option B, Option C, or request a bounded
alternative. If Option A is accepted, owner landing must specify the owning
P4 and P10 contract sections, the exact canonical internal
requirement-source DTO/codec and digest inputs, how the unique P3 Action and
unconsumed Executable approval are supplied/re-read within P1's existing
receipt-first/transaction model, the existing durable stale mapping and
compatibility rules, and P10/Web read behavior. Acceptance must preserve
P9's terminal/no-later-action rule. It must not claim to close second-turn
V6-E drift qualification; that requires separate lawful successor evidence
or another explicitly governed qualification slice. Only after accepted
owner landing and post-landing review should an implementation plan be pinned
and separately authorized.
