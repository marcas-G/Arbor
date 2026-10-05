# Design Gaps

A **Design Gap** is a question the frozen design does not answer, discovered
while projecting or implementing it. Per `AGENTS.md`, implementation stops
on the affected work and the gap is raised for **manual governance**.

## Rules

- A Design Gap is recorded here, **never** resolved by editing
  `docs/design/**` from planning or implementation.
- Only manual governance edits the design document that owns the semantics.
- A gap is closed only when the owning design document is updated and this
  record points to the resolving revision.
- Affected tasks are marked blocked until the gap is closed.
- Planning may fix citation/ownership/structure defects itself; it may not
  invent domain semantics to close a gap.

## Status legend

```text
OPEN     — awaiting manual governance
RESOLVED — owning design doc updated; see resolution
CLOSED   — disposed by a later phase / governance ruling (see file)
```

## Index

| ID | Title | Owning design doc | Affected tasks | Status |
|---|---|---|---|---|
| DG-01 | `hard-bound` Dependency predicate undefined | DID §1.4A, §12.11; System Design §4.9 | P0-006, P0-012, P0-016 | RESOLVED |
| DG-02 | `ExpectedDeliverable` schema & matcher undefined | DID §1.8, §3.6, §8.16, §9.4, §12.11 | P0-012, P0-016 | RESOLVED |
| DG-03 | Policy revision fields inconsistent across §3.x / §8.19 / §12.11 | DID §3.1, §3.2, §8.19, §12.11 | P0-005, P0-006, P0-016 | RESOLVED |
| DG-04 | `PermissionGrantId` missing from Appendix A prefix table | DID §2.1 vs Appendix A | P0-002 | RESOLVED |
| DG-05 | `Workspace.agentBinding` typing vs `AgentBinding` union | DID §1.6, §3.2 | P0-006, P0-015 | RESOLVED |
| DG-06 | Architecture test placement conflict | DID §10.1 vs `AGENTS.md` rule 5 | P0-001, P0-017 | RESOLVED |
| P5-DG-01 | Acceptance story cannot reach `Admit Work(current)` | P5 `05` §1, P5 `02` §2; DID §8.18A; P2 `05` §4 | P5-009, P5-011 | RESOLVED |
| P7-GAP-01 | Vacant-workspace silent wait | P7 / P10 | P10-004, P10-013 | CLOSED (P10 WaitingOnVacantProducer view) |
| DOGFOOD-DG-01 | Settled ProviderTurn with active Execution after fenced session write | DID v1.20 AHT-1…AHT-8; P3 `08`; P9 `07` | Quant-research dogfood recovery (implementation separately gated) | RESOLVED |
| DOGFOOD-DG-03 | Executable filesystem tool target cannot be mapped into the sandbox | DID v1.25 EWB-1…10; P4 `04`/`08`; P11 `12` | Filesystem tools / release-validation Work | RESOLVED |
| DPM-DG-01 | Project directory, rename and close/archive product surface | DID §3.1/§4.2/§5/§12.10–§12.11; P15 project-management contracts | Project management surface | RESOLVED |
| G-V2-1 | AssignWork provenance source | DID v1.26 VDC-5 | Agent AssignWork | RESOLVED |
| G-V2-2 | ToolObservation exact evidence identity | DID v1.26 VDC-2 | B10 Verification | RESOLVED |
| G-V2-3 | Verification conclusion summaryRef | DID v1.26 VDC-3 | B10 Verification | RESOLVED |
| G-V2-4 | initialWork VerificationMission lifecycle | DID v1.26 VDC-4 | Formation / B10 | RESOLVED |
| TOOL-AUTH-DG-01 | Execution tool capability source | DID §8 / P4 invocation authority | Executable Tool Calling | RESOLVED |
| SCRC-DG-01 | Session / Context Runtime convergence | System Design v1.4; DID v1.22; landing `75589c5` | Session timeline, inbox promotion, typed tool items, compaction | RESOLVED |
| SCRC-DG-02 | Context overflow successor ProviderTurn identity | DID v1.23 OVS-1…OVS-7; migration 0020 | SCRC-007/008 | RESOLVED |
| WSC-DG-01 | DependencySatisfied revision-stable transition cannot clear strict revision wait | DID WSC-1; P7 `06`/`07` | WorkflowSignalConsumer DependencySatisfied route | RESOLVED |
| EEB-DG-01 | `Coordination` catch-all mixes unrelated Execution Episodes | System Design v1.6 EGP-1…10; DID v1.28 | Execution Domain, Scheduler, Agent Runtime, Model Context, SQLite, Conversation | RESOLVED |
| CRAC-DG-01 | Root Conversation zero-tool profile blocks governed Arbor actions | System Design v1.7 / DID v1.29 / P17 TurnProfile | Root conversation, child Workspace proposal | RESOLVED |
| RGI-DG-01 | Root goal lacks automatic placement and work-initiation closure | System Design v1.9 / DID v1.31 / MAC-P1/P2 | Root conversation, placement context, AssignWork, Formation, Scheduler | RESOLVED (implementation phase-gated) |
| CAPA-DG-01 | Control Actions lack subject-bound permission and durable approval interruption | System Design v1.8 / DID v1.30 / P12 / P17 / AgentLoopStep | All model-facing Control Actions | RESOLVED |
| SDO-DG-01 | ExecutionBound Specialist lacks usable subagent orchestration | System Design v1.9 / DID v1.31 / MAC-P4 | Runtime subagent context, tools, collaboration, result delivery, limits | CLOSED (optional capability disabled; legacy replay-only) |
| MAC-DG-01 | System complexity exceeds the closed user-value path | Problem v1.3 / Scenarios v1.3 / System Design v1.9 / DID v1.31 / MAC | Vocabulary, golden path, cognition, actions, fulfillment, legacy isolation | RESOLVED |
| FT-DG-01 | UI-created Project has no trusted resource admission | System Design / DID / P12 / P13 | F21 | OPEN |
| FT-DG-02 | Completed Work cannot be inspected by its original link | System Design / DID / P10 / P13 | F05 terminal oracle / F22 | OPEN |
| FT-DG-03 | External Command payloads can persist malformed typed identities | System Design / DID / P12 transport / Application | F23 and all public command shells | OPEN |
| AH7-DG-01 | Settled ToolInvocation lacks replayable bounded Observation | System Design / DID / P3 / P4 / P9 | AH7 settlement→Observation crash seam | OPEN |
| AH7-DG-02 | Reconcilable shell lacks an executable reality-proof contract | System Design / DID / P4 / P9 | AH7 effect→settlement crash seam | OPEN |

All six gaps were resolved by the System Design v1.3 / DID v1.4 governance
patch. Resolution authority is recorded in each gap file.

## P1 Design Gaps (pre-implementation closure)

Discovered during P1 requirements extraction + independent gap review. P1
implementation is blocked until these are `RESOLVED` or explicitly closed by
P1 phase-scoped contracts.

| ID | Title | Owning design doc | Status |
|---|---|---|---|
| P1-DG-01 | Error algebra incomplete (`FencingRejected` / `PersistenceUnavailable`) | DID §6A.4, §6A.5, §4.1, §12.5 | RESOLVED |
| P1-DG-02 | Resolution states / receipt shape / attempt vocabulary | DID §4.1, §7.4, §9.9 | RESOLVED |
| P1-DG-03 | Idempotency identity: `payload_hash` vs `semanticRequestFingerprint` | DID §4.1, §9.9 | RESOLVED |
| P1-DG-04 | P1 fencing scope, predicate, Stop-quiescence interaction | DID §11, §6.3, §9.7, §12.3, §3.4 | RESOLVED |
| P1-DG-05 | `CreateProject` bootstrap paradox + root contents | DID §4.1, §3.1, §3.2, §12.11, §9.13 | RESOLVED |
| P1-DG-06 | Event journal: sequence scope, `eventVersion`, offset atomicity | DID §2.3, §5.2, §5.4, §9.9 | RESOLVED |
| P1-DG-07 | Schema precision: cyclic FKs, table↔domain mapping, root uniqueness | DID §9.1, §9.3, §9.13 | RESOLVED |
| P1-DG-08 | `resource_ownership` persistence lifecycle | DID §9.5, §1.4A, §1.5 | RESOLVED |
| P1-DG-09 | Retention / delete policy and migration mechanism | DID §9.1, §12.11, §5.4 | RESOLVED |
| P1-DG-10 | Port ownership, ID generation, `AssignWork` errors, child-workspace phase | DID §7.2, Appendix B, §0A.1, §11 | RESOLVED |
| P1-DG-11 | Authority predicate undefined for P1 commands | DID §8, §6.2, §12.10, §4.1; P1 01/02 | RESOLVED |

`P1-DG-01/02/03/04/05/10` were resolved by the **DID v1.4 → v1.5** governance
patch (`planning/p1-governance-patch.md`). `P1-DG-06/07/08/09` were P1 phase-scoped and are now closed by
`docs/design/implementation/P1/**` (4-way review round 4, Blocking = 0).

Items explicitly delegated to P1 by DID §13 (exact DDL/migration/indexes;
exact per-command contracts; exact repository/port signatures; resource-region
physical encoding) are **phase-closure**, not gaps; they are closed by the P1
phase-scoped contracts (`docs/design/implementation/P1/**`).

## P5 Design Gaps (pre-implementation closure)

| ID | Title | Owning design doc | Status |
|---|---|---|---|
| P5-DG-01 | Acceptance story cannot reach `Admit Work(current)` (`SelectCurrentWork` ownership) | P5 `05` §1, P5 `02` §2; DID §8.18A; P2 `05` §4 | RESOLVED |

## Resolution process

```text
Design Gap (OPEN)
↓
manual governance edits the owning design doc
↓
update this record -> RESOLVED + resolving revision
↓
update affected planning tasks
↓
resume implementation
```
