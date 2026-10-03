# MAC — Acceptance and Stop Conditions

## 1. Global acceptance

MAC is not complete until:

1. user-visible vocabulary is reduced to the accepted minimal set;
2. LocalPlan has no Domain authority edge;
3. WorkspaceKnowledgeView is real and accepted-source-only;
4. one model ActionCall protocol fronts route-specific execution;
5. asynchronous fulfillment is durably observable;
6. the single-Workspace path is black-box and restart/replay proven;
7. child Workspace placement/formation/Parent Acceptance is black-box proven;
8. Dependency is model-visible only with a complete deliverable path;
9. optional subagent can be disabled without correctness loss;
10. active new turns do not advertise legacy/Specialist vocabulary;
11. owning consumer/recovery Effect errors are typed;
12. every phase passes `pnpm check` and real-provider qualification.

## 2. Phase evidence

| Phase | Required result |
|---|---|
| MAC-P1 | greeting → Work → actions → claim → three-valued Verification → root Acceptance → Completed, with restart proof |
| MAC-P2 | goal placement → formation fulfillment/child Work → Parent Agent acceptance, with duplicate/stale/permission negatives |
| MAC-P3 | declare → produce → deliver → deterministic satisfy → exact wake, including impossible/cycle paths |
| MAC-P4 | optional child Execution collaboration, resource/concurrency safety, disabled-mode equivalence and legacy/approval convergence |

Each result maps every phase exit criterion to a named test/evidence artifact.
Types, handlers and tables alone are not evidence of reachability.

## 3. Mandatory negative proofs

- ordinary greeting creates no Work/Workspace/approval;
- Plan status creates no action or completion;
- model text cannot grant permission or promote memory;
- PASS without Acceptance cannot complete Work;
- Approved without fulfillment cannot display Applied;
- Report text cannot satisfy Dependency;
- AgentResult cannot complete Work or impersonate Verification;
- legacy text cannot reconstruct canonical identity;
- retry/restart cannot duplicate external/canonical effects;
- untyped operational failure cannot disappear into logs.

## 4. Stop conditions

Implementation stops and raises a Design Gap if:

- a new product/domain concept is required but absent from accepted vocabulary;
- an existing concept lacks a unique identity/lifecycle/invariant justification;
- hard safety depends on prompt compliance;
- an async application cannot expose durable fulfillment truth;
- context continuity requires treating raw Session prose as canonical knowledge;
- exact revision/authority/resource binding cannot be proven;
- compatibility requires guessing identity from free text;
- a later optional phase is required to make an earlier phase correct;
- the same blocking condition repeats across three goal turns without a
  governed resolution.
