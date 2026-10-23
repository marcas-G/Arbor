# S2-RDG-01 — SteerWork Revision Implementation Plan (Gated)

Status: **PLANNING ONLY — design acceptance pending; implementation NOT AUTHORIZED**  
Candidate baseline: 366b83045aa59338c8c416179c55de66334b9b9e  
Fixed governance package reviewed: planning/proposals/S2-steer-work-revision-contract-governance-draft.md  
Proposal SHA-256 (UTF-8/LF-normalized): C878BBF615F92ED43125C79EFDC0F021F062FEE97BF740795889B65B44394088  
Independent fixed-package review: planning/results/S2-steer-work-revision-fixed-package.review.md, Blocking = 0, suitable to request manual ACCEPT. The review explicitly says manual acceptance is still required and implementation requires separate authorization.

This plan is derived from that package and source at the candidate baseline. It does not accept the proposal, change docs/design/**, define unaccepted product semantics, or authorize code, migrations, UI, deployment, provider calls, or database writes. Every implementation task below is blocked until both gates in §1 are satisfied.

## 1. Hard gates and scope boundary

| Gate | Required evidence | Unblocks |
|---|---|---|
| G0 — manual design decision | The manual governor explicitly accepts the fixed package token ACCEPT_S2_STEER_WORK_REVISION_CONTRACT_V1; accepted package hash is recorded; only the exact owner landing is applied; independent landing review has Blocking = 0. | Any source, test, schema, DTO, prompt, or Web change. |
| G1 — implementation authorization | A distinct explicit implementation authorization after G0 and landing review, naming this S2-RDG-01 implementation scope. No such authorization is present at this candidate. | Execution of implementation DAG §7. |
| G2 — persistent-data qualification | Disposable schema-51 fixture upgrade/fresh-schema matrix passes; no preserved/user DB is touched; owner approval for any later real-provider/process slot. | Public-process / real-provider qualification only. |

Out of scope: changing S2 goals, making old guidance text normative, inferring amendment fields from prose, patch/merge amendments, weakening required criteria, auto-accepting Fail/Unknown, deleting or relabeling old Verification/Acceptance rows, changing Stop/quiescence semantics, or applying a migration to any non-disposable database.

The S2 proposal is not the same task as existing planning/tasks/P6-012.md: P6-012 covers Critical Steer/Stop quiescence wiring, while this plan covers the unresolved canonical Work-revision contract. Reuse the already-frozen P6 composite; do not treat a Stop-only pass as closure of S2-RDG-01.

## 2. Frozen behavior this plan preserves

- S2 §3–§7: observe without taking over; local correction stays with the existing responsibility unit; ordinary correction does not preempt; explicit Critical correction quiesces; after correction the Agent resumes autonomy.
- SD §7.3: Critical Steer/Stop blocks new actions after commit; in-flight effects follow P4 cancel/confirm/reconcile; OutcomeUnknown is not disguised as ordinary interruption; CancelWork remains distinct.
- P6 04 §2–§5: human-only exact Work/Workspace route, Open Work, expectedWorkRevision CAS, Normal/Critical parity for the Work mutation, Inbox admission, Work remains Open, Critical path uses the same outer SteerWork transaction and exact current Workspace active main. The no-active-main Option A already landed: commit SteerWork + HumanInput and emit/call no Stop leg when the transaction-time lookup is empty; if a main appears after preparation, re-read and resolve Stop authority for that current exact main inside the outer transaction.
- DID WorkRevision binding: semantic Work changes increment the scoped Work revision; Deliverable, Verification and Acceptance bind their exact revision.
- P8 F18 / Verification v2: existing Verification mission/criteria/result/receipt/wake snapshots stay immutable. An old Open Verification may continue on its old missionSnapshot and conclude against its old targetWorkRevision; its wake is exact to (WorkId, targetWorkRevision). Old PASS/FAIL/UNKNOWN remains audit history but never satisfies current-revision Accept/CompleteWork. No auto-cancel or retag.
- P1 Gateway: receipt-first idempotency tuple, exact authority, one TransactionScope, canonical state + receipt + events atomic. Same CommandId/same tuple replays; changed semantic tuple conflicts; terminal rejection has a receipt but no partial canonical facts.

## 3. Candidate end state after both gates

### 3.1 Operation and receipt/API boundary

Retain the human-facing command type SteerWork and the shared P6 handler. Its typed operation becomes a closed discriminator:

    type SteerOperation =
      | { kind: "DirectionGuidance"; guidance: string; scope?: "Direction" | "Constraint" }
      | { kind: "ContractAmendment"; contract: WorkContractSnapshot }

    interface WorkContractSnapshot {
      objective: string;
      why: string;
      constraints: ReadonlyArray<string>;
      completionExpectation: string;
      verificationMission: VerificationMission;
    }

The complete command remains bound to workId, workspaceId, severity, expectedWorkRevision, authenticated HumanInput provenance, and the selected operation. ContractAmendment is full replacement only; omission/merge/patch and inferred defaults are invalid. DirectionGuidance never changes the canonical contract. Existing untagged SteerWork/wire-v1 inputs, including legacy scope="Constraint", decode only as DirectionGuidance and cannot be upgraded by wording.

Candidate internal Effect/API work:

- Extend SteerWorkPayload/SteerWorkResult in packages/application/src/commands/steer-work.ts with the operation discriminator and committed operation kind/digests/revisions; retain the current CommandHandler / CommandOutcome / TransactionScope contract.
- Keep CommandGateway.execute as the only receipt boundary. Handler stays a single command; Critical is still the existing in-transaction direct child-handler composition, not a second Gateway call or second receipt.
- In packages/application/src/external-command-codec.ts, make legacy payloads strict DirectionGuidance and validate new amendments as the explicit new command schema. Candidate receipt-handler schema upgrade is "1" → "2" with explicit priorReceiptSchemaVersions: ["1"] only if P1's exact old-receipt replay rules are preserved. This is a compatibility candidate, not a decision about the global EXTERNAL_WIRE_CODEC_VERSION; P1 must confirm the precise version carrier and old same-ID replay tuple before implementation.
- semanticRequestFingerprint must cover operation discriminator, exact Work/Workspace, severity, expected revision, provenance and full canonical replacement snapshot. Same-ID exact replay returns original receipt/revision; same-ID changed snapshot/discriminator is IdempotencyConflict; stale revision is typed RevisionConflict; no auto-rebase.
- Extend the P1 authority-resolver projection only as necessary to bind the exact Work/Workspace + existing human authority. No new capability, parent/child authority, CAPA approval, PermissionGrant, Sandbox or ResourceBoundary widening. The exact authenticated human command is the explicit amendment confirmation per the fixed package.

One wire detail remains an owner landing prerequisite: the fixed proposal requires the contract amendment to be explicit and versioned, but the current external codec has a single global wire version 1 and no per-command version field. P1/P10 must freeze how the new explicit discriminator maps to handler/receipt schema 2, while preserving old v1 payload and old receipt replay. This plan does not silently bump the global wire version.

### 3.2 Work revision CAS and durable history

Candidate persistence follows current schema 51; the next migration candidate is P52, subject to the final accepted owner contract and migration registry review.

- Add an append-only work_contract_revisions table keyed by (work_id, work_revision), containing the complete snapshot JSON, canonical digest, record kind (Initial, DirectionGuidance, ContractAmendment, LegacyCurrentSnapshot), source command/actor/provenance and recorded time. Work-scoped ordinal is not a new entity ID.
- P52 backfills exactly the current works row/revision as LegacyCurrentSnapshot with historyAvailable=false/equivalent marker. It MUST NOT infer prior revisions from Inbox, Session, events, summaries, Verifier prompts, or old Verification snapshots. Existing event/receipt/DB bytes are not rewritten.
- New AssignWork writes the initial complete snapshot in its existing transaction. Every accepted revision writer must append the exact snapshot; current source has SteerWork as the only production caller of refineIfRevision, and the domain refineWork is pure. Any later writer of semantic Work revisions must join the history contract before release.
- Candidate WorkRepositoryService additions in packages/ports/src/repositories.ts, all requiring TransactionScope:

      replaceContractIfRevision(workId, expectedRevision, completeContract, nextRevision)
      appendContractRevision(record)
      findContractRevision(workId, revision)
      listContractRevisions(workId)

  The exact TypeScript names are implementation candidates; P1/P6 must freeze error/return types. replaceContractIfRevision must CAS exact WorkId + expected revision + Open lifecycle (and owner scope where the repository contract carries it), write all contract fields including why and constraints, and advance exactly once. appendContractRevision enforces the unique tuple and immutable history. Both run inside the outer Gateway transaction.
- Current WorkRepository.refineIfRevision writes only objective/completionExpectation/verificationMission and does not write why or constraints; candidate replacement must cover all five WorkContractSnapshot fields. On unique/CAS conflict, the whole amendment (Work row, history, events, Inbox, receipt success) cannot partially commit. P1 records the existing typed rejection receipt.
- Work history keeps revision 0/current legacy data truthful; old contract snapshots unavailable after backfill are explicitly unavailable, never fabricated. DirectionGuidance still advances revision exactly once and records an identical canonical snapshot at the new revision.

Candidate event plan, to be frozen by P6/P1 during G0 landing: keep WorkSteered v1 unchanged for DirectionGuidance; add a versioned amendment event (candidate name WorkContractAmended) carrying WorkId, from/to revision and snapshot digest, not a duplicate full contract. Both operation kinds continue to produce the existing P10 HumanInterventionApplied provenance and target Inbox input. Critical's Stop events are appended from the existing P2 child handler in that same outer receipt/transaction. The precise event name/version/payload and what bounded Inbox summary represents for an amendment are explicit owner decisions, not code-agent discretion.

### 3.3 Normal/Critical composition and old Verification

- One makeSteerWorkHandler applies the same Operation validation, human authority, Work revision CAS/history, events and Inbox admission for both severities.
- Normal: same outer SteerWork receipt/transaction; no Stop handler; reevaluation and the next WorkEpisode context receive the exact current snapshot plus separately labelled non-normative guidance.
- Critical: makeCriticalSteerCommandHandler remains the production wrapper. Receipt-first preparation and in-transaction active-main recheck remain; transaction-time main → resolve exact P12 StopExecutionAuthority → direct Stop child handler. No main → Option A (Steer still commits with no Stop event). If exact Stop authority/handler fails, Work row/history/events/Inbox and outer receipt all roll back. Never filter active main by WorkId; P6 scope is current Workspace active main. Stop does not cancel Work or mutate verifier history.
- StartVerification in packages/application/src/commands/start-verification.ts currently validates payload.missionSnapshot structurally and exact observed Work revision, then persists the caller-supplied snapshot. P8 must change the source-of-truth boundary: create each new Verification only from the authoritative canonical Work contract snapshot for that exact revision (candidate minimal path: compare the incoming snapshot against the exact Work snapshot and reject mismatch; P8 may instead remove the redundant input in a separately versioned command). Verification.targetWorkRevision remains exact.
- Existing old Open Verification continues on its already persisted mission; its ConcludeVerification and VerificationChanged facts retain old target revision; the old (WorkId, oldRevision) Wait is the only wake target. It neither clears a new-revision Wait nor produces current Acceptance. Existing AcceptWorkOutcome / CompleteWork exact triple/revision checks remain the enforcement backstop. New PASS for the new revision is still needed before current Acceptance/CompleteWork.
- P6 does not auto-cancel old verifier executions or alter side effects. Existing OutcomeUnknown/reconciliation rules are unchanged.

### 3.4 DTO, Web and public process surface

Candidate owning files and seams:

- P10/API DTO: packages/api-contracts/src/views.ts (WorkDetailReq/Res, optionally a new exact WorkRevisionDetailReq/Res); packages/projection-runtime/src/views/work-detail.ts; packages/projection-runtime/src/query-runtime.ts; apps/single-workspace/src/projection-query.ts. CurrentWorkSummary already carries server revision; keep expected revision sourced from it. Extend Work Detail with current full contract and safe digest/history metadata. Exact-revision query must bind (projectId, workspaceId, workId, revision) and return unavailable for unprovable legacy history; never reconstruct from transcript.
- P13 transport/exposure: packages/application/src/external-command-codec.ts, apps/single-workspace/src/transport/composition.ts, docs/design/implementation/P13/02-command-exposure-matrix.md owner landing after G0. Keep SteerWork human-actionable on the exact Work route; reject unknown/missing operation discriminators and all hidden authority/server-only fields. No chat shortcut or Agent-originated amendment.
- Web: apps/web/src/commands/schemas.ts; apps/web/src/commands/forms/SteerWorkForm.tsx; apps/web/src/pages/work/WorkPage.tsx; apps/web/src/views/WorkDetailView.tsx; relevant apps/web/test/command-forms.test.tsx / Work page tests / fixtures. Show current objective, why, constraints, completion expectation and structured verification mission before amendment; default to guidance; explicit switch to a complete replacement editor with a before/after diff, exact expectedWorkRevision, old verification applicability warning, and explicit human submit. Critical retains separate confirmation. On receipt invalidate Work detail, revision history, Verification and Inbox queries; no optimistic contract mutation.
- Public process: extend tests/functional/process/human-steer.functional.test.ts (F07) and tests/functional/process/command-input-validation.functional.test.ts; add or extend public API assertion path only after DTO contract lands. The public journey must use /commands + /views, never read SQLite as the oracle.

P10/P13/P14 owners must settle whether history is one expanded Work Detail DTO or a separate exact-revision query and how Inbox links to history. The UI must not make an unavailable legacy snapshot appear complete. Do not expand chat/RootConversation surfaces; root/child interaction stays within existing command exposure.

## 4. Exact source owners / candidate file map

| Owner | Candidate files at 366b8304 | Planned responsibility after authorization |
|---|---|---|
| Domain | packages/domain/src/work.ts, packages/domain/src/events.ts, packages/domain/src/event-versions.ts, domain tests | WorkContractSnapshot, pure typed amendment/revision behavior and closed event schemas; keep producer-side weaken-protection separate from explicit human amendment. |
| P1 / Ports | packages/ports/src/repositories.ts, packages/ports/src/errors.ts, packages/application/src/gateway.ts, packages/application/src/gateway-contracts.ts, P1 command receipt decoder/contract registry | CAS/history Effect signatures; exact receipt/schema compatibility and one outer transaction. No new gateway or side channel. |
| P6 Application | packages/application/src/commands/steer-work.ts, packages/application/src/critical-steer.ts, packages/application/src/authority-resolver.ts, apps/single-workspace/src/registry.ts, apps/single-workspace/src/transport/composition.ts | Strict decode, provenance, state transition; shared Normal/Critical handler and existing exact Stop composite. |
| SQLite persistence | adapters/persistence-sqlite/src/work-repository.ts, new work-contract-revision-store.ts or a WorkRepository extension, adapters/persistence-sqlite/src/migrations.ts, new p52-work-contract-revision-migration.ts, migration registry/fixtures | P52 append-only history + safe current-only backfill; Work full-field CAS; history read/write in same Tx. |
| P8 | packages/application/src/commands/start-verification.ts, packages/application/src/commands/conclude-verification.ts, packages/application/src/commands/accept-complete.ts, adapters/persistence-sqlite/src/verification-store.ts, tests/p8-acceptance-commands.test.ts and P8 focused suites | Exact canonical mission snapshot for new verification; old version remains immutable/inapplicable; existing revision-bound wait/acceptance semantics preserved. |
| P10 read models | packages/api-contracts/src/views.ts, packages/projection-runtime/src/views/work-detail.ts, packages/projection-runtime/src/query-runtime.ts, apps/single-workspace/src/projection-query.ts, Work detail contract tests | Exact current/history DTOs; owner-routed read-only snapshot/history. |
| P13/P14 Web | apps/web/src/commands/schemas.ts, apps/web/src/commands/forms/SteerWorkForm.tsx, apps/web/src/pages/work/WorkPage.tsx, apps/web/src/views/WorkDetailView.tsx, Web fixtures/tests; P13 02/P14 owned contract | Explicit two-mode form, exact revision binding, inspectable before/after and old Verification applicability; authenticated human only. |
| Public qualification | tests/functional/process/human-steer.functional.test.ts, tests/capability/real-provider/public-s2-supervision-steer-stop.test.ts, test-owned schema fixture helpers | First deterministic public /commands + /views journey, then separately authorized real-provider and process/restart evidence. |

These are candidate targets, not an instruction to begin touching them. Owners may refine exact file split only after G0/G1, without changing accepted semantics.

## 5. Candidate P52 schema/upgrade rules

Candidate table (DDL not yet approved):

    CREATE TABLE work_contract_revisions (
      work_id TEXT NOT NULL REFERENCES works(work_id),
      work_revision INTEGER NOT NULL CHECK (work_revision >= 0),
      contract_json TEXT NOT NULL,
      contract_sha256 TEXT NOT NULL,
      record_kind TEXT NOT NULL CHECK (record_kind IN
        ('Initial','DirectionGuidance','ContractAmendment','LegacyCurrentSnapshot')),
      source_command_id TEXT,
      actor TEXT,
      provenance_json TEXT,
      recorded_at TEXT NOT NULL,
      history_available INTEGER NOT NULL CHECK (history_available IN (0,1)),
      PRIMARY KEY (work_id, work_revision)
    );

The candidate snapshot JSON is the full five-field Work contract in §3.1, canonicalized before digesting. LegacyCurrentSnapshot is the only allowed unavailable-history marker and is created only for the exact Work row present at upgrade time. Candidate CHECK/trigger design should enforce non-null provenance for new command-created rows, immutable rows, no deletes, and no duplicate revision; P1/persistence owner must review exact FK/trigger consequences before acceptance/implementation.

Migration P52 (requiresUserVersion: 51, CURRENT_SCHEMA_VERSION: 52) is additive. It creates the table and backfills one LegacyCurrentSnapshot per existing Work at its current revision. It does not alter works, Verification v2 tables, receipts, events, criteria, mission snapshots, or existing user bytes. Fresh DB path seeds snapshots for initial Work creation. Schema-51 upgrade must be idempotently atomic under the migration runner; interrupted apply either rolls back or resumes according to the existing migration transaction contract. Candidate qualification includes schema-51 → 52, fresh schema, repeated upgrade, malformed/current-row mismatch rejection, duplicate tuple, append immutability, and current row/history consistency.

No destructive down migration. Before any v2 amendment has been accepted, an application rollback may leave the additive P52 table unused. After the first v2 amendment, rollback may not delete history, lower Work revision, alter receipts/events, or reapply an old mission; use a forward fix. Any migration failure testing uses disposable fixtures only.

## 6. Failure handling / invariants

1. Validate registered wire schema strictly; unsupported discriminator, incomplete contract, invalid mission, malformed IDs or hidden fields fail closed with existing typed Problem/rejection surfaces.
2. In the single Gateway Tx, receipt tuple lookup/replay first; then exact human authority, Work scope, Open lifecycle, and expectedWorkRevision; then domain validation; then Work CAS + history append + event(s) + Inbox/HumanIntervention + (Critical exact Stop child effect) + receipt. Any error before commit has no partial Work/history/event/Inbox/Stop facts.
3. A competing command at the same old revision has one CAS winner. Loser gets RevisionConflict; no automatic rebase or receipt reuse under a different snapshot.
4. Same CommandId + exact snapshot/severity/operation replays the original receipt and never increments again; same CommandId + changed snapshot, discriminator, severity or expected revision is IdempotencyConflict. Rejection receipt replay remains deterministic.
5. Work always stays Open after Steer/Amendment. No implicit Cancel/Complete. Guidance is non-normative. The new Work mission is complete human-authored replacement, not model-derived.
6. Old Verification/Acceptance/result evidence stays immutable and revision-bound. Only current-revision PASS + exact Acceptance can CompleteWork.
7. Normal and Critical produce identical contract and revision facts; Critical adds only the frozen exact active-main quiescence leg. Stop errors roll back the whole outer command.
8. Legacy history unavailable is visible as unavailable, not reconstructed. No fake past Work snapshots or fabricated Verification mission.

## 7. Layered implementation/test DAG (all blocked by G0 + G1)

    G0 accepted design + owner landing + independent review
      ↓
    T1 Domain / codec / receipt contracts
      ↓
    T2 P52 disposable migration + Work CAS/history repository
      ↓
    T3 P6 Gateway transaction + Normal/Critical composition + replay/concurrency
      ↓
    T4 P8 current mission sourcing + old Verification revision behavior
      ↓
    T5 P10/API DTO + P13 exposure + P14 Web forms/history
      ↓
    T6 deterministic public /commands + /views process journey
      ↓ (G2 and separately booked owner slot)
    T7 real-provider / Critical-stop / restart qualification

| Task | Minimum focused tests / evidence | Depends on |
|---|---|---|
| T1 — Domain + codecs | Pure amendment validation: complete replacement only, normalizer/digest stability, direction text never alters contract, terminal/unauthorized/stale rejection; external v1 scope=Constraint remains DirectionGuidance; unknown fields fail closed; v2 exact fingerprint and schema; exact old v1 receipt replay and changed-tuple IdempotencyConflict. | G0/G1 |
| T2 — Schema + repositories | Migration 51→52 disposable upgrade and fresh schema; current-only legacy backfill; interrupted/retry/foreign/malformed rows; Work CAS one-winner; snapshot append-only/no update/delete; all contract fields persisted; assignment initial snapshot; current Work/history consistency inside a transaction. | T1 |
| T3 — P6 command/receipt | Exact authority, Work/Workspace/project scoping, Open lifecycle, expected revision; Normal same transaction and no Stop; Critical current-main exact Stop in same receipt/Tx; transaction-time main differs from preparation; no-main Option A; Stop handler/authority failure rolls back all; exact replay once; changed payload conflict; two-connection concurrent CAS. | T2 |
| T4 — P8 versioning | New StartVerification cannot accept a noncanonical mission for the current revision; old Open v2 Verification continues unchanged on old mission and produces old target revision; old PASS/FAIL/UNKNOWN never satisfies new revision; old wait wake exact; new revision Wait not cleared by old conclusion; exact current Acceptance/CompleteWork only. | T3 |
| T5 — Projection/Web | Exact Work Detail identity; full current contract rendered; available/unavailable history behavior; explicit direction/amendment switch; amendment complete form/diff and server revision; stale UI conflict requires refetch/reconfirm; old Verification warning; Critical extra confirmation; submit invalidates/refetches history + current Work + Verification + Inbox. | T2/T4 |
| T6 — Public process | Public /commands + /views only: create/approve Work, Normal amendment updates canonical snapshot and revision exactly once, producer consumes correction, independent new Verification uses new mission, old Verification still audits old revision and cannot accept new Work, current PASS + acceptance completes; separate Critical path proves no new effects after exact stop and Work stays Open. No SQLite oracle. | T3/T4/T5 |
| T7 — Qualification | Real-provider normal S2 exact correction; real-provider Critical in-flight effect stop path; hard restart/replay before/after receipt commit; verify process/daemon cleanup and zero retries; record exact run scope. These are separately authorized and do not follow automatically from unit/public deterministic PASS. | G2/T6 |

Test typecheck/Biome and architecture/owner boundaries are incremental gates between layers. Do not run full suite or real provider merely because this planning file exists; use the normal repository gate only after an authorized implementation slice and owner slot.

## 8. Rollback and release safety

- Before G0/G1: this file is the only permitted change; delete nothing and do not create code changes in owner packages.
- Before any new amendment is committed: migration is additive, so a code rollback may leave P52 data unused; no down migration is required or allowed to rewrite legacy facts.
- After amendments are committed: no rollback may decrement revision, remove P52 snapshots, rewrite a receipt/event, cancel an old Verification, or reinterpret a v1 steer as amendment. Keep schema/history and use a forward fix; pause new amendments only by a separately reviewed/approved deployment control that leaves Normal DirectionGuidance and history integrity well-defined.
- Operational qualification uses isolated disposable DB/workspace only. Never migrate, read, or mutate the preserved/user online DB. Stop/restart tests must not overlap production daemons or external effects.
- Release is blocked if any Work writer can increment revision without a corresponding full snapshot; any old Verification can satisfy a new revision; any Critical Stop failure leaves a partial Work amendment; any UI path can submit a partial amendment; or migration cannot prove current-only legacy backfill.

## 9. Plan completion criteria

This planning task is complete when the owner accepts the proposed task DAG and the two explicit gates remain visible. It does not close S2-RDG-01, claim design acceptance, grant implementation permission, or qualify S2. On any owner/contract mismatch discovered during implementation, stop at that layer and raise the exact evidence as a design/implementation blocker; do not patch docs/design/** or invent fallback semantics.
