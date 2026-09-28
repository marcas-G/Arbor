# Capability Coverage Matrix

**Audit date:** 2026-09-27  
**Rule:** Only a complete L3 PASS can produce `CAPABILITY_PROVEN`.

| Capability | L1 component | L2 integration | L3 black-box | Real provider required | Overall |
|---|---|---|---|---:|---|
| B01 Basic Human Conversation | PASS | PARTIAL PASS | NOT RUN | YES | NOT PROVEN |
| B02 Executable Tool Use | PASS | PARTIAL PASS | NOT RUN | YES | NOT PROVEN; S01 qualification unauthorized |
| B03 Control Action | PARTIAL PASS | PARTIAL PASS (legacy/direct path only) | BLOCKED | YES | NOT PROVEN |
| B04 Multi-turn Memory | PASS | PASS (request composition only) | NOT RUN | YES | NOT PROVEN |
| B05 Human Steer | PASS | PASS (durable command/effect) | NOT RUN | YES | NOT PROVEN |
| B06 Parent/Child Communication | PASS | PASS (message/Inbox/correlation) | NOT RUN | YES for Parent cognition | NOT PROVEN |
| B07 Responsibility Delegation | PASS | PASS (governed formation workflow) | BLOCKED | YES for model proposal | NOT PROVEN |
| B08 Specialist Delegation | PASS | PASS (admission/settlement seams) | BLOCKED | YES | NOT PROVEN |
| B09 Dependency/Deliverable | PASS | PASS (matcher/transition mechanics) | NOT RUN | YES for Agent initiation | NOT PROVEN |
| B10 Verification | PASS | PASS (records/authority/lifecycle) | BLOCKED_BY_DESIGN_GAP | YES | NOT PROVEN |
| B11 Completion/Acceptance | PASS | PASS (deterministic lifecycle gates) | NOT RUN | YES for producer judgment | NOT PROVEN |
| B12 Restart/Continuation | PASS | PASS (persistence/recovery) | NOT RUN | YES | NOT PROVEN |
| B13 Failure Recovery | PASS | PASS (scripted fault/reconciliation) | NOT RUN | YES for model-visible handling | NOT PROVEN |
| B14 Web/Product Projection | PASS | PASS | PARTIAL PASS (narrow P13 HTTP claims only) | YES for generated Assistant reply | NOT PROVEN |

`PASS` in the L1/L2 columns is limited to the described seam in
`01-existing-test-evidence-audit.md` and `04-gray-box-integration-matrix.md`.
It does not mean every test in the repository has been audited or labeled.

## Current counts

- Phase 1 full root run: **1,253 cases**; 1,252 passed and 1 failed.
- Current ordinary suite collection: **1,259 root + 208 Web = 1,467 cases**,
  with L1 **456**, L2 **751**, L3 **6**, MIXED **79**, UNKNOWN **175**.
- Isolated real-provider project: **2 executable L3 cases** (B01 and B04);
  both are `NOT_RUN` until the explicit provider configuration is present.
- Current ordinary file count: **253 suites**; isolated real-provider project:
  **1 file**.
- Complete B01–B14 capabilities meeting L3: **0 of 14**.
- Narrow external HTTP L3 tests exist for P13 claims, but none completes a
  B01–B14 capability card.

Every current test file has a suite-level category and rationale in
`suite-evidence-inventory.json`. The two isolated real-provider cases have
explicit per-case metadata through the capability harness.
