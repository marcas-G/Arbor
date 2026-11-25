# RAI-DG-02 all-terminal-Provider-failure hold acceptance

**Disposition:** ACCEPTED — implementation authorized for the exact proposal.

**Owner decision:** The project owner selected “方案 A” on 2026-11-25:
every non-cancelled Provider failure whose durable final Attempt is
`TerminalFailure + Stop` creates an exact Work-revision readmission hold.

**Proposal:** `planning/proposals/2026-11-25-terminal-provider-failure-all-stop-readmission-hold.md`

**Proposal SHA-256:** `1d9a44ce4e726105250c08ddb51875e537ded00853090ce54097ba222e7ccf46`

This record authorizes only the additive gate/type/projection/test
landing described there. It does not claim release qualification.

## Failure evidence

The disposable real-provider acceptance database
`/home/lgao/.local/share/arbor-current-live-ccVvDp/data/arbor.db` recorded:

- `7,585` total Executions;
- `7,584` WorkEpisode Executions;
- `7,585` failed Executions;
- `7,585` `TransportFailed / TerminalFailure / Stop` Provider Attempts;
- one canonical Open Work revision repeatedly re-admitted.

The daemon was stopped before further executions were generated. The source
database is evidence only and is not modified by this landing.

## Consistency review

The implementation keeps the existing ownership boundaries:

- P3/provider-runtime still decides retry versus stop inside one Provider Turn;
- P2 owns the canonical readmission proof and admission-time recheck;
- P7 remains the sole runnable classifier;
- P10 only presents a query-derived bounded fact;
- P6's existing revision-advancing `SteerWork` remains the recovery action.

The code changes do not add a fake Provider, an internal user shortcut, a
synthetic WorkWait, a migration or a same-revision retry command.

## Qualification status

The P2 readmission-gate suite passes `61/61` after the change. Full source
typecheck, production functional coverage, a new Linux preview artifact and
the real browser journey remain required before any release claim.
