# Verification Delivery Convergence Tasks

**Status:** IN PROGRESS — VDC-001..007 implemented and live-proven; VDC-008 awaits Parent acceptance; VD-RUNTIME-GAP-01 CLOSED

**Plan:** `planning/proposals/verification-delivery-convergence-implementation-plan.md`

## Track A — existing-contract implementation

### VDC-001 Event fidelity

- [x] Add failing SettleExecution tests for exact top-level
  `executionId/workId/workRevision/claimRef`.
- [x] Prove non-Work settlements omit the optional completion fields.
- [x] Enrich `ExecutionSettled` from trusted Execution binding + settlement.
- [x] Prove command/event/receipt atomicity and replay identity.

### VDC-002 Historical reconciliation

- [x] Add fixture matching the current nested CompletionClaim event shape.
- [x] Add deterministic legacy-claim scanner/checkpoint.
- [x] Resolve Work from durable Execution binding; never infer from Session.
- [x] Route through the existing Verification Consumer + CommandGateway.
- [x] Prove five duplicate revision-1 claims converge to one Verification.
- [x] Prove restart and post-commit crash re-entry.

### VDC-003 Start/spawn qualification

- [x] Start exactly one revision-1 Verification for the dogfood Work.
- [x] Assert mission/owner/revision/environment snapshots.
- [x] Bind the caller-preallocated verifierExecutionId.
- [x] Prove commit→spawn crash reuses the same identity.
- [x] Confirm producer WorkWait remains active and no producer main is admitted.
- [x] Stop at governance gate before evidence/conclusion if VD is unaccepted.

## Track B — after `ACCEPT_VERIFICATION_DELIVERY_CONVERGENCE`

### VDC-004 Evidence identity

- [x] Land VD-1 owning contracts.
- [x] Persist ToolInvocationId + observationRef + executionId + callRef source.
- [x] Runtime-bind source fields; model selects but never authors identities.
- [x] Reject missing/stale/foreign/non-terminal sources.
- [x] Add replay and cross-execution authority tests.

### VDC-005 Summary binding

- [x] Land VD-2 Verification/state/event/DDL contracts.
- [x] Persist summary bytes through BlobStorePort.
- [x] Verify BlobRef resolves before command submission.
- [x] Persist summaryRef atomically with conclusion.
- [x] Emit summaryRef in VerificationConcluded.
- [x] Test orphan-blob, retry and immutable-conclusion paths.

### VDC-006 Initial mission lifecycle

- [x] Land VD-3 proposal/initialWork contracts.
- [x] Remove new-work `p6-placeholder` production path.
- [x] Require explicit valid mission whenever initialWork exists.
- [x] Prove child-without-initialWork remains valid.
- [x] Prove later refinement advances Work revision and invalidates old bindings.

### VDC-007 Live verifier

- [x] Spawn exact-bound Verifier Execution.
- [x] Record evidence for all three required dogfood criteria.
- [x] Conclude Pass/Fail/Unknown with durable summaryRef.
- [x] Prove VerificationChanged clears the WorkWait.

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
