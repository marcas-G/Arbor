# AH7-DG-01 / P39-P40 ReconciledNoEffect Compatibility Addendum — Pre-review Result

Date: 2026-10-11
Status: **draft only; awaits independent review and separate manual acceptance**

## Fixed dependencies

| Package | Accepted LF SHA-256 |
|---|---|
| AH7-DG-02 logical / D0A | `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` |
| AH7-DG-02 P39 physical / D2FF | `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C` |
| AH7-DG-01 logical / 19EF | `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD` |
| AH7-DG-01 accepted P40 physical / 5B61 | `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A` |

The P39 post-landing review was reported as Blocking=0 / 25 owner files
matched. The coordinating Governor also reported an independent P39/P40 bridge
review confirming that P39 `ReconciledNoEffect` lacks durable bounded
Observation bytes and recommending compatibility Option B. Those review
artifacts were not present in this tree; this result does not invent artifact
paths or hashes. Local evidence is preserved in
`planning/results/AH7-DG-01-P39-ReconciledNoEffect-compatibility-blocker.report.md`
and the accepted D0A/D2FF source documents cited there.

## Draft addendum files

- Proposal:
  `planning/proposals/AH7-DG-01-P39-P40-ReconciledNoEffect-compatibility-addendum-draft.md`
  LF SHA-256: `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`
- SQL/source/replay/legacy/kill matrix:
  `planning/proposals/AH7-DG-01-P39-P40-ReconciledNoEffect-compatibility-matrix.md`
  LF SHA-256: `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`

The proposed compatibility reuses the accepted P40 version-1, 16 KiB hashed
Observation envelope for P39 `ReconciledNoEffect`, while preserving P39's
`MayHaveStarted`, immutable same-attempt `selected_fact_id`, NotOccurred proof
fact and Artifact rules. It distinguishes the NULL P39 fact `result_ref`, the
P4 invocation Artifact `result_ref`, and P3's bounded-payload `resultRef` hash.
Legacy P39 terminal rows remain unchanged; missing evidence blocks a still-
Pending action without ToolResult/cursor projection. The proposal also blocks
Runtime startup/release at P39-only `user_version=39` and requires a binary
with the expanded v1 Observation decoder before opening `user_version=40`;
P36–P40 prefix, serialized cross-process migration runner and P39
Windows/sidecar gates remain unqualified. The owner map assigns the startup gate
to P1 `04`/`06`, the RNO union/codec/trigger/hash to P4 `01`/`02`/`06`, the
source formula to P3 `08`, the fact/event to P9 `07`, the closed Attention source
and marker/rebuild/API surface to P10 `02`/`04`/`05`/`07`, and the
non-reconstruction rule to P4 `07`. The matrix distinguishes P3 handoff
COMMIT-before/after crash/restart and adds legacy Missing→P9/P10 marker/offset
atomicity and retained-horizon rebuild.

This is a new compatibility semantic package, not an amendment silently
covered by either accepted proposal. No owner/design files were changed; no
production/migration code or tests were touched; no tests, daemon, migration,
or release qualification were run. P40 owner landing must remain paused until
the exact addendum and matrix are independently reviewed and separately
accepted.
