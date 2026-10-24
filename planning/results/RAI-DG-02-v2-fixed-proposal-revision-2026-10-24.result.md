# RAI-DG-02 V2 fixed proposal revision — 2026-10-24

Status: **revision complete; independent review and manual acceptance pending**.

Proposal:
`planning/proposals/RAI-DG-02-terminal-provider-failure-readmission-hold-draft.md`

Raw SHA-256:
`FA1AFC6675E040698F69E5EE29C67DE92EA10D54228D476A6DA27E2A98B8FA93`

Requested acceptance token:
`ACCEPT_RAI_DG_02_TERMINAL_PROVIDER_FAILURE_HOLD_V2`

The V2 revision dispositions the prior independent review's four Blocking and
two Nonblocking findings:

- B1: zero or more candidate Executions may bind the same Work revision; each
  candidate chain is individually exact, and the bounded source now includes
  `logicalStepNo` and `repairAttempt`.
- B2: P10 presentation is explicitly query-derived from the P2-owned proof
  query with no event, queue, ACK, offset or marker. A bounded
  `TerminalProviderFailureIntegrity` surface and exact targeting fallback are
  defined.
- B3: hold/Attention are active only for exact-revision Open Work; authorized
  Completed/Cancelled terminalization makes the retry row inactive without
  deleting evidence, while only revision-advancing Steer resumes execution.
- B4: the matrix now covers both sides of Attempt, failed ProviderTurn, Step
  and Execution commits; retry-budget/deadline negatives; synchronized
  settlement/admission/Steer races; and hundreds of historical repetitions.
- N1: removed the impossible `FailureFingerprintMismatch`; invalid occurrence
  time is the bounded integrity reason.
- N2: only the three closed `TerminalFailure + Stop` kinds qualify regardless
  of final Execution reason text.

No `docs/design/**`, production code, migration, database or real Provider was
changed or run for this proposal revision. The prior review is evidence for V1
only and does not count as an independent review of this V2 hash.
