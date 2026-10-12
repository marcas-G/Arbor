# AH7 Same-holder Owner Boundary — Design Landing Record

Date: 2026-10-12  
Landing baseline: `e6734c56e7a5cd1609421b41f8a611a68e7ec8c5`  
Landing status: **Accepted fixed package applied exactly; independent post-landing review pending.**

## Governance Q/A chain

1. The user's first structured choice accepted the behavior in
   `planning/proposals/AH7-same-holder-invocation-owner-disposition-draft.md`
   at SHA-256
   `FBCBAB1D2A3EE245A8561C683C460EF8F7329DC72A47D3AAC92B18C564ADBB76`:
   **“不支持复制身份（推荐）：生产坚持单 Worker 串行；保留原严格红测作待治理诊断，补真实租约接管资格后才调整默认门禁。”** The
   response and its date are recorded in
   `planning/results/AH7-same-holder-owner-decision.record.md`.
2. The user was then shown the exact owner-document landing package at
   `planning/proposals/AH7-same-holder-owner-boundary-design-landing-draft.md`,
   SHA-256
   `57C522120E5E58CAE568C30A96BAE02EC10B0C5C591E8F2A6D3F568E3078FCCC`, and
   asked whether to accept that fixed text package for landing. The user's
   exact structured response was **“接受固定落地包（推荐）”** on
   2026-10-12.

The second answer is bound to the package hash above. It activates the
AGENTS.md manual-governance delegation exception for that package only. The
landing below is exactly its five insertions; no additional design semantics
were inferred.

## Owning-file revisions

The implementation-contract files have no separate file-level version field;
their frozen revisions are identified by path and SHA-256. The Authority
column records the version label present in each file. Each post-landing hash
is calculated after applying the accepted insertion.

| Owner | Authority label | SHA-256 before | SHA-256 after | Applied scope |
|---|---|---|---|---|
| `docs/design/implementation/P2/02-port-contracts.md` | DID v1.7 G4 | `8A6DA2491CD83ACD8F70817824286B4F3E7A78425C631E1A95901DEDA1A469A6` | `BF268F20A94955E91CDF2E4060A55C0E94DE4148C01E9BB9AE4C0004A6B78FDF` | §5, ExecutionDriverPort single-flight entry follows successful LeaseService acquisition. |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | DID v1.7 G1; AH7-DG-03 amendment | `4F4CFA2F1FFC2860A7BE7F0C3DBD2EAFF2C59CC9D3B8CCF04593525604D2A485` | `B9DC0DC5F8A0D68EAF759FF0D53DD656BFFDEA911B04CE03BE78A38349C736F9` | §2, production ExecutionOrigin provenance is the acquired LeaseRecord; copying does not create a second owner. |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | DID v1.20 AHT-1…8; implementation authorized by DID v1.21 ALS-I1 | `736015FF9D4C001B95E61B834ADE086495DE504F6CC73957667460E6F594B6F2` | `6175ECF7A4D0D84B565A10E8111EB96784E9CF91D1D2764F043944ABA2DD3AF9` | §7, one action at `nextActionIndex` is invoked/resolved/committed before the next. |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | DID v1.8 §7.6; AH7-DG-03 amendment | `CBE1B98F8817236070A9655D558061B04E2C92E37FEBC281F99206B6E98C3161` | `32C338CC7E12A595AD39F53B12FEFDB110476469940B820925E88B7FCD0184B4` | §2, production caller boundary is the single current P3 action; P4 does not arbitrate copied-fence overlap. |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | DID v1.20 AHT-1…8; AH7-DG-03 amendment | `01D76830AA39F8935A0AF031E94DC46F11E806FF722079CDAD6E5D27750F68DF` | `D2262522B1C0D2A7EF8D6B6D382E6678084A12064790C88CB77196E1046760B0` | §4, AH7 qualification distinguishes real LeaseService G0/G1 takeover from cloned-holder contexts. |

`docs/design/02-system-design.md` and
`docs/design/03-detailed-implementation-design.md` were not changed; their
top-level versions and hashes remain those of the accepted baseline.

## Exact diff summary

- P2 `02`/`03` now state that production driver authority enters through that
  run's successful lease acquisition and that copied context does not create
  a second active driver.
- P3 `08` now states the one-at-a-time action progression already used by the
  production AgentLoop.
- P4 `02` now states the same-holder concurrent direct invoke is not an
  invocation-level P4 capability; it preserves sequential `MayHaveStarted`
  recovery and existing NonIdempotent `OutcomeUnknown` behavior.
- P9 `07` now requires AH7 cross-generation qualification to exercise actual
  P2 G0/G1 lease ownership, no G1 effect replay, and late-G0 fencing.

No table, ADT, failure tag, API port, migration, P38/CAPA approval rule or
P4 `MayHaveStarted` recovery state was changed.

## Qualification prerequisite and default-test boundary

The selected package's G0/G1 prerequisite is covered by the existing
`p4-ah7-tool-settlement-lease-fencing.functional.test.ts` process qualification:
G0 effect after admission, actual G1 LeaseService generation acquisition,
no replay, late G0 settlement rejection, one effect and `OutcomeUnknown`.
Its isolated fixture fast-forwards the `expires_at` timestamp with SQL before
the real G1 acquisition; it does not claim a natural wall-clock TTL wait.
The separate live-lease process case proves that a second daemon is rejected
while G0's lease remains live. Evidence and limits are in
`planning/results/P4-AH7-tool-settlement-lease-fence.result.md` and
`planning/results/AH7-same-holder-owner-decision.record.md`.

This landing does **not** adjust default tests. The five strict same-holder
Runtime cases identified in the accepted package remain in their current
locations for independent review. After the reviewer returns Blocking=0, the
default-test reclassification is a separate implementation change: retain one
intent-CAS test and add an effect-admission CAS-only test without any Executor
count assertion; keep real live-lease and G0/G1 takeover qualification in the
default process suite; move all five same-holder Runtime functions into the
explicit diagnostic config with their exact strict oracles preserved. The
test-only G0/G1 caveat about expiry fast-forward must remain visible.

## Post-landing review state

**Independent consistency review: pending.** No review result is claimed in
this record. Required review checks are listed in the accepted package's
“Cross-owner consistency review checklist.” The reviewer must return
Blocking=0 before any default-test classification change. No test or full
gate was run for the design landing.

