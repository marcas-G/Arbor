# P10 → P1 Pre-Intent CandidateRead Bootstrap — Fixed Implementation Plan

Status: **PLAN ONLY — IMPLEMENTATION NOT AUTHORIZED**

## Pinned owner contract

This plan implements only the accepted owner landing at
`d5c7d694f668671a6c39815dea300f4345a61088` and its review record at
`0c6ba21dd20dda7cc4fb626c65f6b1776a5b910d`.

Accepted tokens and source proposals:

- `ACCEPT_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_V1`, proposal SHA-256
  `009A965AE81F64E051625E8AC33DD499D0A6EEB35B3D3055941F96A207F00A6C`.
- `ACCEPT_P10_P1_PREINTENT_STALE_RECEIPT_BINDING_OPTION_A`, proposal SHA-256
  `FDF4F4036385DC30722F0A21BFF8E20E1C6F1A136B2CF7DE32310FD1F141FEA4`.
- `ACCEPT_P10_P1_PREINTENT_SOURCE_PROOF_CORRECTION_V1`, proposal SHA-256
  `525170A7F8B7FC01741497CA5619094E20805EDAA37142A7D441306190E20073`.

The exact design postimages and accepted decision are in
`planning/results/P10-P1-preintent-candidate-read-bootstrap-governance-decision.md`
and `planning/results/P10-P1-preintent-candidate-read-bootstrap-landing-manifest.md`.
The post-landing review is `planning/results/P10-P1-preintent-candidate-read-bootstrap-post-landing-review.md`
(B0=0/B1=0/B2=0). Do not change the accepted source contract, reopen
`docs/design/**`, or extend P9 semantics during implementation.

## Goal and explicit non-goals

Implement the already-accepted public path:

```text
P3 Pending Executable Action
→ P4 ApprovalRequired (no ToolInvocation)
→ exact Pending/unconsumed Executable approval is admitted
→ public P10 CandidateRead (same safe V2 DTO)
→ human commits existing P1 policy request
→ human resolves that existing approval
→ existing P4 transaction stores intent + consumes exact Approved revision
```

The pre-intent requirement is a read-only proof, not a durable row or action.
The P1 request, handler schema 2, semantic fingerprint, decision result,
SQLite schema, P9 fact/queue behavior and P9 terminal/no-later-action rule are
unchanged. No P4 ToolInvocation, RecoveryBinding, effect admission, provider
call, approval consumption, Observation, ToolResult, event, Attention or
settlement is created by CandidateRead or source preparation.

This plan does not qualify the later second-ProviderTurn/registry-drift
sequence after a P9 unavailable action. DID P4/06/P9/07 remains authoritative:
a typed provider-unavailable action terminalizes its Action/Step and admits no
later action in that ProviderTurn. T3 providers remain Experimental; no
provider/helper run, Supported-state change, deploy, release, or online DB
operation is in scope.

## Frozen internal source proof

P4/06 owns the closed in-memory
`SandboxPolicyPreIntentRequirementV1`; implementation uses exactly its
accepted field set:

```ts
{
  _tag: "SandboxPolicyPreIntentRequirementV1",
  version: 1,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  expectedEpisodeRevision,
  providerTurnId,
  logicalStepNo,
  repairAttempt,
  logicalActionId,
  actionIndex,
  callRef,
  actionRevision,
  inputHash,
  toolName,
  toolVersion,
  approvalId,
  approvalState: "Pending",
  approvalRevision,
  approvalConsumedBy: null,
  approvalExpiresAt,
}
```

Validation uses existing branded ID/revision/hash/timestamp decoders. P1
compares every typed field structurally, with exact canonical EpisodeBinding
equality. There is deliberately no source codec, canonical JSON encoding,
hash, KAT, persistence, P1 fingerprint input, external payload field or
public source identity. Do not compare via incidental object key order or
`JSON.stringify`.

P1 preparation resolves the exact pinned P3 action's arguments with existing
P11 rules outside the write transaction. P11 TargetRefs/access are not fields
of the source proof and are not serialized. The plan must reuse only existing
P1/P11 CAS values: WorkspaceRevision, ResourceBoundaryRevision,
selected-profile SandboxHandleBindingDigestV1 and existing P5
authority/operator/provider-registry revisions/digests. Do not add a
targetResourceIdentityDigest, TargetRef digest, target-source CAS field, new
P11 revision or filesystem/P11 resolver call inside P1's transaction.

The existing post-intent `SandboxPolicyRequirementV1` remains byte/semantics
compatible: exact NotAdmitted ToolInvocation + Bound RecoveryBinding remains
its source. P10 reads either closed variant from the same P4
`SandboxPolicyRequirementReadPort`; it does not access P3/P4 private stores.

## Required P4/P10 source behavior

The pre-intent variant is available only after:

- the exact active Execution/Episode is nonterminal and not stop-requested;
- its exact current Step is ActionsInProgress at `nextActionIndex`;
- exactly one current P3 Executable Action is Pending, pinned to the
  ProviderTurn/Step/LogicalAction/actionIndex/callRef/actionRevision/inputHash/
  toolName/toolVersion;
- the existing P4 `ApprovalRequired` path admitted exactly one P4 Executable
  approval row for that same action, in `Pending`, with the exact
  approvalId/revision/expiresAt and `consumedBy = NULL`;
- no ToolInvocation or RecoveryBinding exists for that exact Action yet.

Missing valid source returns None. Duplicate, ambiguous, malformed or
cross-bound source evidence is a typed fail-closed read/corruption failure,
not a partial candidate. An Approved/Rejected/Expired/Cancelled/consumed
approval, non-Pending/noncurrent Action, stopped/terminal Execution, or an
already-created P4 intent is not this pre-intent variant; once a NotAdmitted
intent exists, use the existing post-intent variant. No source is reconstructed
from Session text or model-authored IDs.

P10 combines the proof with the exact current P1 decision/result, full P5
bundle and existing P11 complete boundary/ownership/profile-handle barrier.
It emits the existing CandidateRead V2 DTO and existing
`InitialDecision` reason; no new view property, reason, CandidateId format,
sorting, public field, candidate persistence or auto-selection is introduced.
The candidate remains presentation-only and does not authorize P1 by itself.

## Required P1 prepare, CAS, stale, and replay behavior

1. Keep authenticated P1 grant/provenance preflight, semantic fingerprint,
   advisory receipt lookup and final receipt-first lookup in their accepted
   order.
2. If no committed receipt exists, read/materialize P4 pre-intent proof,
   P11 boundary/target source and P5 authority/provider snapshot outside
   `BEGIN IMMEDIATE`; carry the proof only in an internal prepared value.
3. Inside the existing final transaction, after the final receipt lookup,
   re-read the current P3 Action and P4 approval using transaction-scoped
   read ports. Do not open a nested transaction or perform filesystem, P11
   resolver or provider I/O. Structurally compare all P3/P4 source fields.
4. Check P1's existing current Workspace/Execution/Episode/Policy/Boundary/
   Handle/P5 CAS fields. Check approval `approvalExpiresAt > trusted
   GatewayNow` in this same transaction even if the approval row revision has
   not advanced.
5. Stale classification is closed and deterministic: compare the Action
   source first; a changed/missing/moved Action returns
   `StaleSandboxPolicyInputs(ActionRevision)`. Only if Action matches, a
   changed/missing/non-Pending/consumed approval or time-only expiry returns
   `StaleSandboxPolicyInputs(ExecutableApprovalRevision)`. If both are stale,
   ActionRevision wins. Duplicate/corrupt source evidence remains a typed
   fail-closed integrity/read error, not an invented stale field.
6. A stale rejection commits only the existing P1 terminal receipt/Command
   row in the normal transaction; it writes no decision/event and consumes no
   approval. On success, decision/result/receipt/event retain their existing
   single-transaction atomicity.

The source tuple is not part of `semanticRequestFingerprint`. A same
CommandId with an existing schema-1 or schema-2 receipt returns that exact
historical result before source reads; no old bytes are rewritten. New
DecideSandboxPolicy submissions remain handler schema 2 and the existing
external payload is unchanged. The result decoder/view add only the two safe
`safeDetails.field` literals; no result version bump, SQL object, migration or
historical receipt rewrite is allowed. P13 maps both to the existing fixed
generic stale/refetch message; it never displays IDs, revision values,
expiry, source proof or digest and never auto-resubmits.

## TDD work DAG and gates

### Wave 0 — strict source fixtures / red cases

- Build one strict typed P3 Action + P4 approval fixture using production
  codecs/repositories; no partial casts or guessed IDs.
- Add red source-read tests for missing, duplicate, malformed, terminal,
  Approved, Rejected, Expired, Cancelled, consumed and different-cursor
  Action/approval rows.
- Add structural comparison tests that mutate each accepted tuple field
  independently, with exact Action-first dual-mismatch precedence.

### Wave 1 — P4 pre-intent requirement producer

- Implement the read-only P4/06 union branch using the existing P3 Action,
  P4 ExecutableApproval ledger and caller TransactionScope.
- Prove it runs only after the existing ApprovalRequired/Pending+Inbox path,
  and creates no Invocation, RecoveryBinding, approval consumption, P3
  transition, event, marker, Attention or Effect.
- Preserve every post-intent NotAdmitted/Bound-RecoveryBinding test unchanged.

### Wave 2 — P10 public CandidateRead

- Add the new P4 requirement variant to the existing P10 same-snapshot query.
- Reuse existing P11 full-boundary/ownership/profile-digest and P5 bundle
  barriers. Keep DTO/reason/order/candidate IDs and redaction exactly fixed.
- Exercise public Workspace Detail; do not call the pure candidate producer
  directly to manufacture a P1 request.

### Wave 3 — P1 source CAS + receipt compatibility

- Extend P1 internal prepared/current-precondition DTOs with the exact P4
  source tuple; compare structurally in the existing Gateway transaction.
- Add two safe stale field literals to application/domain/API result unions
  and strict result decoding; no handler schema, request codec or fingerprint
  change.
- RED/GREEN matrix: each Action field drift; each approval identity/state/
  revision/consumedBy/expiry drift; time-only expiry while stored row remains
  Pending at the same revision; simultaneous Action+approval drift; missing
  sources; current boundary/handle/P5 CAS drift; same-CommandId replay before
  changed-source read; fresh-CommandId stale receipt; legacy schema-1 exact
  receipt replay; unknown stale-field decode rejection.
- Assert no decision/event/approval consumption on stale; exact current
  success preserves decision/result/event bytes and no source proof in
  `result_json`.

### Wave 4 — P13 + public and restart qualification

- Map both safe field literals to the same generic stale/refetch UI; no
  candidate/Action/approval identifiers or auto-submit.
- Fresh disposable schema-50 public flow: P3 Action → ApprovalRequired / P4
  Pending approval → public CandidateRead → P1 Committed receipt → human
  ResolveExecutableApproval → first exact P4 intent after approval.
- Prove the P4 intent/approval consume transaction remains atomic and restart
  reuses the same P3 Action/approval without another Provider request.
- Real process kill matrix: before P1 transaction commit (no decision/event/
  receipt); after commit (all durable and same-CommandId exact replay); after
  policy commit before human approval; Action source race; approval resolution
  race; trusted-time expiry with unchanged approval row revision.
- Use only fresh/disposable SQLite. No online DB, migration/upgrade,
  production provider/helper, deployment or release.

## Completion evidence and stop conditions

For each wave: RED evidence first, then focused module/adapter tests, typecheck,
build, targeted architecture/Biome, diff check and small commit. After all
waves, run the registered public/schema-50 qualification and independent
implementation review. Do not run the full suite until targeted gates and
their resource/time budget are established. The result must explicitly state
that second-ProviderTurn/drift remains open because the P9 terminal
unavailable contract is unchanged. Stop and request governance if the exact
P11 current CAS cannot bind the prepared action target without a new target
digest, or if P9 would need to continue after terminalization.

This plan pins accepted contracts only. It authorizes no source edit, test
execution, migration, provider support claim, deployment, release or database
operation. A separate implementation token is still required.
