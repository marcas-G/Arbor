# P10 — 02 Attention Read-Model (GQ3)

**Authority:** DID v1.13 G3/G8; SD v1.3 §12.3 (three severities, bubbling), §14 No.42/55; DID §6.2 L6 rows; P7 `05` (DeadlockAttentionRequested), P9 `01`/`04` (ReconciliationEscalated); `planning/gaps/P7-GAP-01.md`.
**Status:** DRAFT.

## 1. Fact sources → severity → target (frozen mapping)

| Source | Fact carrier | Severity (SD §12.3) | Target |
|---|---|---|---|
| Dependency Unfulfillable | DependencyMarkedUnfulfillable event | Attention | consumer workspace |
| Deadlock | DeadlockAttentionRequested event | Attention — emitted only under the No.42 project-idle gate (P7 `05` §2), so by frozen semantics every emitted deadlock fact is already Action Required; the read-model renders it as such (no conditional branch exists) | each cycle-member workspace |
| Runtime Safety Envelope | safety-stop record / Interrupted(RuntimeSafetyStop) settlement fact | Attention | execution workspace |
| Recovery escalation | ReconciliationEscalated event | Action Required (unreconcilable side effect — SD §12.3 explicit) | execution workspace |
| Verifier orphan | Open verification × settled executions (derived condition, P8 `02` §3) | Attention | owner workspace |
| Vacant producer (P7-GAP-01) | derived: dependencies(Unsatisfied ∧ WorkspaceBound) × works(无 Open Work ∧ ¬Retired) | Attention | consumer workspace (view label `WaitingOnVacantProducer`) |

- Normal is the absence of facts (default state, not a row).
- Human-required approval maps to Action Required when a governance gate awaits human decision (formation approval pending — P6 `01` §4).

## 2. Bubbling (subtree aggregation)

- A workspace's subtree-attention summary = aggregated counts by severity over descendants; **context is never copied upward** (SD §12.3). The Tree view renders the summary; drilling in resolves detail.
- Dedup on read: keyed by the fact source's frozen dedup identity (ReconciliationEscalated: executionId+invocationRefsFingerprint; Deadlock: cycle fingerprint; derived views: their natural join key). Bubbling aggregates deduplicated facts, not raw events.

## 3. Read-model contract

- Pure function of canonical state + journal; materialized incrementally via the generic consumer (P1 `05`); rebuildable (`04`).
- **Never performs canonical mutation** (GQ3/G8): disposition of any attention row is a human/parent governance command (S3 step 12: Withdraw / MarkUnfulfillable / steer / stop).
- GAP-01 closure: the vacant-producer view is implemented here and may not be silently descoped (gap file's non-blocking declaration).

## 4. Must Not Decide

- No new attention severities beyond SD's three; no automatic escalation actions; no notification transport (P12).
