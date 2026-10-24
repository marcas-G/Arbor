# S3 AnyProducer Settled-Wait Implementation — Layered Result

**Status:** APW-1/APW-3 source and focused regression layers implemented;
**S3 remains unqualified**. No real Provider qualification was run.

## Authorization and design identity

- Accepted design package: `S3_ANY_PRODUCER_SETTLED_WAIT_GOVERNANCE_DRAFT`,
  SHA-256
  `5b558d26b4140631f5c7a14bb743b1e42a9d8992d50feee1a3d2c3c98353b7c8`.
- Design acceptance token: `ACCEPT_S3_ANY_PRODUCER_WAIT_ELIGIBILITY_V1`.
- Conditional implementation token:
  `AUTHORIZE_S3_ANY_PRODUCER_WAIT_ELIGIBILITY_IMPLEMENTATION_AFTER_LANDING_REVIEW`.
- Landing review commit `0b19c187d9c33be74be06af19c57400e4ea9ec12` reports
  `Blocking = 0`; source work began after that condition was met.
- The exact acceptance record is
  `planning/results/S3-any-producer-wait-package-acceptance-20261024.record.md`.

## Implemented layers

- L1: `apps/single-workspace/src/any-producer-evidence.ts` reads Project,
  Workspaces, Works, formation proposal/fulfillment and Deliverables in one
  transaction snapshot. It recognizes only another same-Project Open Work, an
  exact Approved in-flight initial-Work fulfillment, or a persisted Deliverable
  passing the existing P7 matcher. It does not inspect Work/proposal prose,
  Message, Inbox, or Provider text. Missing Project/root evidence fails as an
  operational read error.
- L2: `apps/single-workspace/src/control-actions.ts` gates only a new
  model-authored `DeclareDependency(AnyProducer)`. Exact current Action/Command
  receipts are checked before evidence; schema/fingerprint/typed result and
  canonical Dependency identity are validated. Evidence absence returns the
  existing `AgentActionRejected(action/precondition, ChooseAlternative)` before
  Gateway submission. P7 command behavior and other ProducerBindings remain
  unchanged.
- L3: `apps/single-workspace/src/projection-query.ts` derives eligible legacy
  waits read-only in a transaction snapshot. It requires the exact fresh
  DependencyChanged WorkWait, Open consumer Work, idle Project, no pending
  formation or approved materialization, and no APW-3 producer evidence. A
  matcher-passing Deliverable suppresses Attention while its exact deterministic
  satisfaction receipt is absent/nonterminal; Committed and TerminalRejected
  receipts are excluded. `packages/projection-runtime/src/attention.ts` and
  `attention-loader.ts` emit only the existing
  `WaitingOnVacantProducer` source/dedup family, with a fixed summary and no
  canonical write.
- No DDL, schema/API label, event, receipt namespace, wake behavior, or design
  document changed. The focused scripted-provider public-process test source is
  `tests/functional/process/s3-any-producer-wait-recovery.functional.test.ts`;
  it is not a real-provider qualification.

## Verification

- `pnpm --filter @arbor/single-workspace build` — PASS.
- `pnpm --filter @arbor/projection-runtime build` — PASS.
- Focused Vitest run: AnyProducer evidence/APW-3 eligibility, AH10 receipt-first
  regressions, and existing P7/P10 acceptance/coordinator/read-model suites —
  **5 files, 74 tests PASS**.
- `pnpm exec biome check` on the changed implementation/test/plan files — PASS.
- `git diff --check` — PASS.
- Full `pnpm exec tsc -p tsconfig.test.json --noEmit` — **not green** due four
  existing diagnostics outside this change in
  `packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts`
  (lines 386–390 access `inputItems` on `PortableModelRequest`). No S3 source or
  test file reported a TypeScript error.
- The scripted public-process attempt did not reach the test body: fixture
  startup returned HTTP 503 because `web dist`/`webStaticIndex` is absent in
  this worktree. This is a startup prerequisite failure, not an APW behavior
  failure. The later run below used the built Web assets and reached the case.
- No real Provider, private Provider configuration, or live database was
  accessed.

## Qualification boundary

The one scripted public-process slice is qualified only at the scope stated
below; it does not qualify S3 end-to-end. The real public S3 journey remains a
separate serial gate and requires separate explicit run authorization; the
implementation token does not authorize it.

## Independent-review follow-up

The follow-up review's APW-3 query/coverage blocker is addressed in the
subsequent commit. The full read-side query is now a shared
`apps/single-workspace/src/any-producer-attention.ts` function called by both
production `projection-query` and the P10 SQLite fixture adapter. The former
pending RED was promoted to `tests/p10-any-producer-attention.test.ts` and runs
under the normal test suite; it no longer injects a precomputed candidate.

The P10 SQLite regression now executes the actual query against canonical
Project, Work, Dependency, WorkWait, Execution, formation, Deliverable and
Command receipt stores. It covers fresh/stale/cleared Wait, active Project
Execution, Pending formation, matching Deliverable with absent or retryable
receipt (suppress Attention), matching Deliverable with Committed or
TerminalRejected receipt (surface Attention), and a before/after database
snapshot assertion for zero writes. The APW-3 pure reducer matrix remains as a
separate unit layer.

APW-1 regression now has explicit cases for evidence absence (ModelUsable
rejection, zero Gateway calls), exact current receipt replay before checking
changed evidence, and prior-generation Committed receipt replay while the
subsequent evidence callback would reject. The direct P7 command path remains
covered by the acceptance/coordinator suites.

Follow-up verification: the focused combined run passes **5 files / 71 tests**;
single-workspace build and Biome pass. Full test TypeScript checking remains
blocked only by the same four unrelated `PortableModelRequest.inputItems`
diagnostics listed above. No public process, daemon or Provider was started for
this follow-up.

## Scripted public-process qualification slice

- Exact candidate: `617c34d6fea03e311701a7570df962bb84534f87`.
- Exact command:
  `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/s3-any-producer-wait-recovery.functional.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism`
- Terminal result: exit 0; **1 file / 1 test PASS**; case duration 14,000 ms,
  total duration 36.13 s.
- Qualified scope: over the public process, an unsupported AnyProducer attempt
  with no eligible producer evidence is rejected; no Dependency is committed,
  no WorkWait is created, and the model asks the user for clarification.
- The provider in this process test is scripted. This is narrow public-process
  evidence only; it is not a live-model or real-provider result and does not
  qualify the full S3 Parent/Child collaboration, delivery, verification and
  acceptance journey. S3 real-provider qualification remains **OPEN**.
