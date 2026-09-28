# Core Capability Catalog

**Audit date:** 2026-09-27  
**Rule:** The status is for the complete user-visible capability case. Passing
components or integration seams are listed separately and do not imply
`CAPABILITY_PROVEN`.

| ID | Capability | L3 case needs a real provider? | Strongest existing evidence | First-case status |
|---|---|---:|---|---|
| B01 | Basic Human Conversation | YES | New public HTTP→daemon→durable transcript RECORDING integration; separate real-provider test prepared | `NOT_RUN` for L3 |
| B02 | Executable Tool Use | YES | P4 ToolRuntime integration and provider adapter components | `NOT_RUN` — S01 qualification is explicitly unauthorized |
| B03 | Control Action | YES | Direct SendMessage/Application integration only; it is not the adopted control route | `BLOCKED_BY_IMPLEMENTATION` — ControlToolRegistry is not authorized/implemented |
| B04 | Multi-turn Memory / Cognitive Continuity | YES | L2 request assembly includes recent answered turns through scripted fetch | `NOT_RUN` |
| B05 | Human Steer | YES | Durable normal/critical steer integration | `NOT_RUN` |
| B06 | Parent / Child Communication | YES for cognition consuming the message | New real-BlobStore→Message→Inbox L2 integration plus durable message/correlation suites | `NOT_RUN` for cognition; L2 prerequisite runs |
| B07 | Responsibility Delegation | YES for model recognition/proposal | Governed formation and child creation integration | `BLOCKED_BY_IMPLEMENTATION` for model-driven action route |
| B08 | Specialist Delegation | YES | ExecutionBound admission and deterministic settlement integration | `BLOCKED_BY_IMPLEMENTATION` for adopted model-facing control route |
| B09 | Dependency / Deliverable | YES for agent initiation | Produce/Deliver/matcher integration | `NOT_RUN`; model-facing match request is not qualified |
| B10 | Verification | YES | Command/evidence/conclusion integration | `BLOCKED_BY_DESIGN_GAP` |
| B11 | Completion / Acceptance | YES for producer completion judgment | Deterministic Pass→accept→complete and stale/fail guards | `NOT_RUN` |
| B12 | Restart / Continuation | YES | SQLite recovery, fencing, and no-blind-replay integration | `NOT_RUN` |
| B13 | Failure Recovery | YES for model-visible judgment/recovery | Scripted provider/tool/worker fault integration | `NOT_RUN` |
| B14 | Web / Product Projection | Not for read-only projection; YES for generated Assistant response | P13 HTTP e2e and P14 UI/projection component/integration tests | `NOT_RUN` for the complete conversation semantics case |

No capability in B01–B14 meets the complete L3 proof rule in this audit.
`ResponsibilityHandoff` remains explicitly `DEFERRED`; it is not a supported
B07 case.

## Existing verification design gaps relevant to B10

The working tree contains source audits in
`planning/tool-surface-review/40-v2-field-source-closure.md`,
`41-verification-reference-semantics.md`, `42-initial-work-verification-mission-decision.md`,
and `44-g-v2-3-conclusion-summary-closure.md`. They record open
`DESIGN_UNRESOLVED` mappings, including exact ToolObservation identity
(G-V2-2), durable summary reference association (G-V2-3), and the initial
Work/VerificationMission lifecycle (G-V2-4). The audit does not close or
reinterpret these findings. B10 remains blocked until manual governance
closes the applicable reference semantics.
