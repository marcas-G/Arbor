# AH7-DG-01 Physical Schema Supplement — Pre-review Result

Date: 2026-10-11
State: **draft prepared; awaiting independent review / manual acceptance**

The fixed-proposal dependency is `ACCEPT_TOOL_SETTLEMENT_OBSERVATION_REPLAY`, proposal
SHA-256 `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`, on baseline
`f80ee9132774c0c1fb570744d81398fad17da188`. This supplement does not authorize owner
landing, migrations, production code, tests, daemon runs, or AH7 closure.

Proposal path: `planning/proposals/AH7-DG-01-physical-schema-supplement-draft.md`
Proposal LF SHA-256: `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`

The proposal fixes P40 as a cumulative-only migration after P36 AH7-DG-03, P37 AH10, P38 EA,
and conditional P39 AH7-DG-02. It includes inline bounded UTF-8 BLOB evidence (16,384-byte
cap), five DG01 evidence-bearing tag/result-ref/Artifact/P3 replay mappings, plus an explicit
DG03 `Denied/NotAdmitted` exception: preserve closed `reasonCode` + `projectionVersion:1`
deterministic replay, require all DG01 evidence fields and result_ref NULL, and never map
Denied to ExpectedFailure. Trigger NULL checks use COALESCE fail-closed semantics. Legacy
DG01 evidence remains nullable/untouched and first replay fails closed. The proposal also
includes terminal immutability, winner-CAS/fence rules, P9 fact/event DDL, and a P10
source-specific Action Required marker table with row/offset/reset/rebuild atomicity. The
P10 failure code is internal-only; the fixed path-free summary is the only user-facing detail
and excludes tool output, causes, paths and secrets.

AH7-DG-03 remains an external dependency: its accepted owner/design work is on a distinct
branch and is not integrated into baseline f80. The proposal does not repeat or resolve the
DG03 denial semantics; it adds only the P40 physical compatibility branch after prefix
integration. Owner landing must verify the reason-code/projection columns and closed code set
against DG03's accepted contract.

No new product/runtime behavior gap was discovered beyond the already accepted logical
proposal. The independent review found that the first P40 trigger draft's five-tag-only
`ELSE 0` path would reject accepted DG03 Denied rows; rev5 adds the NotAdmitted/reasonCode
exception with no DG01 evidence, wraps JSON-path validation in COALESCE to fail closed on
NULL, and records P10's AttentionSource/ATTENTION_SOURCES/API
read-model enum additions in the owner map. This physical supplement makes explicit
additional decisions that require their
own independent review/acceptance before owner landing: exact P9 attention-fact ID byte
serialization/event envelope; P10 source literal and fixed summary/query-owner confirmation;
and cumulative migration registration plus single-runner startup enforcement for P36–P40.
If review rejects any of those exact decisions, revise/accept that narrow physical contract
before editing `docs/design/**`.

Owner review map is in §5 of the proposal. Validation was limited to `git diff --check` and
LF/no-BOM/hash inspection. No tests, daemon, migration, production code, test files, owner
design documents, or push were run/touched.
