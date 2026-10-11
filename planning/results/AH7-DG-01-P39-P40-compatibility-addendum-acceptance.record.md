# AH7-DG-01 / P39-P40 ReconciledNoEffect Compatibility Addendum — Acceptance Record

Date: 2026-10-11
Status: **fixed compatibility addendum accepted for owner-contract landing; implementation and release remain unauthorized**

## Fixed accepted package

| Item | Exact accepted input |
|---|---|
| Accepted P39 logical contract / D0A | `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` |
| Accepted P39 physical contract / D2FF | `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C` |
| Accepted AH7-DG-01 logical proposal / 19EF | `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD` |
| Accepted AH7-DG-01 P40 physical supplement / 5B61 | `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A` |
| Accepted P39/P40 compatibility addendum | `planning/proposals/AH7-DG-01-P39-P40-ReconciledNoEffect-compatibility-addendum-draft.md`; LF SHA-256 `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830` |
| Accepted SQL/source/replay/legacy/kill matrix | `planning/proposals/AH7-DG-01-P39-P40-ReconciledNoEffect-compatibility-matrix.md`; LF SHA-256 `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35` |

The coordinating Governor reports independent review of the compatibility
addendum and matrix as **Blocking = 0**. The review artifact is not present in
this worktree; this record does not invent a review filename or hash. The
independent bridge finding and earlier landing stop are preserved in
`planning/results/AH7-DG-01-P39-ReconciledNoEffect-compatibility-blocker.report.md`.

## Accepted compatibility decision

P39 `ReconciledNoEffect` is part of P40's same
`p4-canonical-tool-observation-v1`, 16 KiB bounded/hash-checked inline
Observation envelope. P40 must bind the exact P39
`MayHaveStarted`/`Reconciliation`/`Bound` terminal row and same-invocation,
same-attempt selected `RecoveryInput/NotOccurred` fact without changing
`selected_fact_id`. The P39 NotOccurred fact keeps `result_ref=NULL`; the P4
terminal row and canonical Observation bind their separate non-NULL P4
ArtifactRef; P3's existing bounded-payload content hash/source formula remains
distinct and unchanged. A pre-P40 RNO row is never backfilled or replayed by
re-execution: a valid generation with a still-Pending action returns
`Missing`→RecoveryBlocked/P9 fact/P10 Attention with no ToolResult/Observation/
Action/cursor write. Full rules and kill matrix are the two accepted files above.

P39 owner contracts/migration may land, but a P39-only database at
`user_version=39` is maintenance-only and MUST NOT start Agent/P4 Runtime or be
released. The cumulative migration/startup chain must reach P40 `user_version=40`
before service start; a P39-only binary must refuse schema 40. The P36→P40
prefix, serialized cross-process migration runner, P39 Windows/sidecar and
filesystem qualification remain explicit gates, not claims of this acceptance.

## Authority and scope boundary

This record accepts exactly the fixed logical, physical and compatibility
hashes above for owner-document landing under the user's standing manual-
governance delegation. It does not authorize production implementation,
migration execution, runtime startup at P39, Windows deployment, tests, release,
or AH7 phase closure. P36 Denied/approval, P37 Deliver, P38 EA, P39
RealityProof/sidecar/selected-fact, all five original DG01 tags, and their
existing P3/P9/P10 contracts remain unchanged except for the exact compatible
P40 RNO branch accepted in the addendum.
