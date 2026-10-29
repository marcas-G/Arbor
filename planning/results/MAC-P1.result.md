# MAC-P1 — Single-Workspace Golden Path Result

**Date:** 2026-10-04
**Status:** COMPLETE / FORMALLY CLOSED
**Phase:** `planning/phases/MAC-P1-single-workspace-golden-path.md`

## Outcome

The minimum user path is reachable and restart-safe:

```text
Human goal
→ RootConversation assign_work(current)
→ exact approval, zero Work before approval
→ one Open Work after approval
→ WorkEpisode actions / optional LocalPlan
→ CompletionClaim
→ independent verifier ToolRuntime evidence
→ PASS
→ exact root Human Acceptance
→ CompleteWork
→ hard process restart without replay
```

The public-process black-box now starts Work through natural-language Root
conversation rather than direct AssignWork command injection.

## Exit-criterion evidence

| Criterion | Evidence | Result |
|---|---|---|
| 1. Full path without internal nouns/IDs | `tests/capability/black-box/s1-s4-public-api.test.ts` | PASS |
| 2. Durable async truth | control approval ledger, AgentLoopStep, Verification/Acceptance consumers; crash suites | PASS |
| 3. LocalPlan zero authority | `packages/agent-runtime/src/local-plan.ts`, `tests/architecture/mac-architecture.test.ts` | PASS |
| 4. Exact Verification + Acceptance before complete | public black-box + P8 Story A/command suites | PASS |
| 5. Accepted-source-only WorkspaceKnowledgeView | `apps/single-workspace/test/mac-p1-workspace-knowledge.test.ts` | PASS |
| 6. No later-phase dependency | MAC-P1 TurnProfile hides formation/message/dependency/legacy specialist | PASS |
| 7. Typed golden consumer errors | verification/completion consumers expose exact repository/gateway/transaction unions; no owning `orDie` | PASS |
| 8. Restart/replay matrix | public hard restart + P9 consumer interruption/replay suites | PASS |
| 9. Real provider + full check | B01/B03/B11 official DeepSeek; `pnpm check` | PASS |
| 10. Result mapping / Blocking | this record | PASS / 0 |

## Behavioral matrix G1–G15

| ID | Proof |
|---|---|
| G1 greeting creates no Work | P14 conversation + B01 real provider |
| G2 bounded goal yields pending exact approval | MAC Root black-box + B03 Root real-provider sentinel |
| G3 approval/replay creates one Work | `mac-p1-root-work-initiation.test.ts` + control approval idempotency tests |
| G4 prohibition preserved | direct handler, Root black-box constraint assertion |
| G5 typed tool failure remains model input | typed executable outcome/Agent Loop suites |
| G6 provider interruption before effect | P17/provider recovery suites |
| G7 interruption after durable effect | AgentLoopStep handoff/AHT suites |
| G8 claim keeps Work Open and starts one Verification | wave2 claim + P8 consumer A |
| G9 FAIL keeps Work Open | P8 conclusion/wake suites |
| G10 UNKNOWN is not PASS | P8 conclusion/acceptance negative suites |
| G11 PASS enables but does not imply Acceptance | P8 acceptance suites |
| G12 exact root acceptance closes Work | public-process black-box |
| G13 acceptance/completion restart is idempotent | P9 interruption + public hard restart |
| G14 Knowledge rebuild excludes unaccepted/FAIL | MAC knowledge test |
| G15 Plan optional | golden black-box completes without requiring Plan |

## Architecture changes

- `LocalPlan` types/store are owned by ports/Agent Runtime cognition; active
  production code no longer imports Domain `WorkPlan/reviseWorkPlan`;
- physical `work_plans` remains compatibility storage;
- WorkspaceKnowledgeView contains accepted PASS Work summaries and exact
  verification/artifact refs only;
- RootConversation exposes only `assign_work` during MAC-P1 and forces current
  target;
- WorkEpisode exposes only current-phase controls;
- Verification/Completion consumer repository/gateway failures remain typed;
- generic driver tests inject test TurnProfiles instead of using a production
  universal control surface.

## Verification

```text
pnpm check PASS
Biome             875 files
Architecture       28 files / 149 tests
Core              297 files / 1656 passed / 3 skipped
Web                31 files / 216 tests
Build              PASS; existing >500KB chunk warning only
```

Skipped cases are two explicitly superseded historical WorkspaceWork
AssignWork approval-route tests plus the existing Windows-conditional resolver
case. Their MAC replacement is the passing Root approval/rejection black-box.

Real-provider evidence:

```text
planning/testing/core-capability/reports/capability-real-provider-2026-10-03T17-01-18.989Z-fc1b617d-2589-4181-98b5-0e3203215a45.md
planning/testing/core-capability/reports/capability-real-provider-2026-10-03T17-28-36.441Z-8defa8df-a245-4940-acab-67a0b9742426.md
```

Both selected qualification batches have FAILED = 0. The second includes the
real Root `assign_work` sentinel with approval-before-mutation proof.

## Closure

Blocking = 0. MAC-P2 entry gate is satisfied.
