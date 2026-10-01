# Verification Delivery Convergence Tasks

**Status:** PREPARED — Track A implementation-ready; Track B governance-gated

**Plan:** `planning/proposals/verification-delivery-convergence-implementation-plan.md`

## Track A — existing-contract implementation

### VDC-001 Event fidelity

- [ ] Add failing SettleExecution tests for exact top-level
  `executionId/workId/workRevision/claimRef`.
- [ ] Prove non-Work settlements omit the optional completion fields.
- [ ] Enrich `ExecutionSettled` from trusted Execution binding + settlement.
- [ ] Prove command/event/receipt atomicity and replay identity.

### VDC-002 Historical reconciliation

- [ ] Add fixture matching the current nested CompletionClaim event shape.
- [ ] Add deterministic legacy-claim scanner/checkpoint.
- [ ] Resolve Work from durable Execution binding; never infer from Session.
- [ ] Route through the existing Verification Consumer + CommandGateway.
- [ ] Prove five duplicate revision-1 claims converge to one Verification.
- [ ] Prove restart and post-commit crash re-entry.

### VDC-003 Start/spawn qualification

- [ ] Start exactly one revision-1 Verification for the dogfood Work.
- [ ] Assert mission/owner/revision/environment snapshots.
- [ ] Bind the caller-preallocated verifierExecutionId.
- [ ] Prove commit→spawn crash reuses the same identity.
- [ ] Confirm producer WorkWait remains active and no producer main is admitted.
- [ ] Stop at governance gate before evidence/conclusion if VD is unaccepted.

## Track B — after `ACCEPT_VERIFICATION_DELIVERY_CONVERGENCE`

### VDC-004 Evidence identity

- [ ] Land VD-1 owning contracts.
- [ ] Persist ToolInvocationId + observationRef + executionId + callRef source.
- [ ] Runtime-bind source fields; model selects but never authors identities.
- [ ] Reject missing/stale/foreign/non-terminal sources.
- [ ] Add replay and cross-execution authority tests.

### VDC-005 Summary binding

- [ ] Land VD-2 Verification/state/event/DDL contracts.
- [ ] Persist summary bytes through BlobStorePort.
- [ ] Verify BlobRef resolves before command submission.
- [ ] Persist summaryRef atomically with conclusion.
- [ ] Emit summaryRef in VerificationConcluded.
- [ ] Test orphan-blob, retry and immutable-conclusion paths.

### VDC-006 Initial mission lifecycle

- [ ] Land VD-3 proposal/initialWork contracts.
- [ ] Remove new-work `p6-placeholder` production path.
- [ ] Require explicit valid mission whenever initialWork exists.
- [ ] Prove child-without-initialWork remains valid.
- [ ] Prove later refinement advances Work revision and invalidates old bindings.

### VDC-007 Live verifier

- [ ] Spawn exact-bound Verifier Execution.
- [ ] Record evidence for all three required dogfood criteria.
- [ ] Conclude Pass/Fail/Unknown with durable summaryRef.
- [ ] Prove VerificationChanged clears the WorkWait.

### VDC-008 Parent acceptance and completion

- [ ] Present exact Verification/revision to Parent/human.
- [ ] Submit AcceptWorkOutcome only for deliberate acceptance.
- [ ] Consume WorkOutcomeAccepted through deterministic CompleteWork.
- [ ] Prove seven-fold revalidation and Work lifecycle `Completed`.

## Closure

- [ ] Current dogfood Work is Completed or has an explicit honest Fail/Unknown
  disposition; never silently left Open.
- [ ] No active main Execution and no stale WorkWait.
- [ ] Verification/Acceptance/Completion rows are mutually revision-consistent.
- [ ] Consumer offsets caught up; dead letters zero or explicitly dispositioned.
- [ ] Restart matrix passes.
- [ ] `pnpm check` green.
- [ ] Write `planning/results/verification-delivery-convergence.result.md`.
