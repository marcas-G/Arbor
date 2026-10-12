# P41 / 0041 fact-key nullability amendment — independent post-landing review

Date: 2026-10-12
Review type: read-only consistency review of the exact owner landing commit.

## Decision

**B0 — Blocking = 0.** Independent review found no blockers in the accepted
physical amendment landing.

## Reviewed identity and provenance

- Owner landing commit: `de50bc24b8b3c1ded2dab5486c465aa531ec2265`.
- Landing base: combined governance `251b47de9b58a22d404345945d3b416ec2884c4f`.
- Accepted amendment proposal:
  `planning/proposals/P41-0041-nullable-primary-key-amendment-draft.md`,
  LF SHA-256 `BE7E9CC9F3528ADBA90EF67615FE1C24E92B5FE751782151882ACAA4531E2BC9`.
- Proposal review:
  `planning/results/P41-0041-nullable-primary-key-amendment-review.md`,
  LF SHA-256 `27740A79287CCBACB92D05983EF4661A048DE46440AD7883AAFDF3E4FC76A142`,
  final B0 / Blocking = 0.
- Manual acceptance token: `ACCEPT_P41_0041_FACT_KEY_NOT_NULL_PHYSICAL_AMENDMENT`.
- Independent reviewer: `/root/p41_null_pk_review`.

## Owner postimage review

The reviewer confirmed the v1.44 base hashes and v1.45 postimages recorded in
`planning/results/P41-0041-nullable-primary-key-amendment-postimage-manifest.md`:

| Owner file | Base LF SHA-256 | Landed LF SHA-256 |
|---|---|---|
| `docs/design/03-detailed-implementation-design.md` | `1990E2DCE2EAB46E700AF6FCE566496E525D29AE8B88747F3CEF61F6194897F2` | `CCA4CB967A0FD45D4756E7DB2175E494956E06B4E0A55BCEE1619EE5552B3C17` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `927FF7273C9C90133E796E1FF9A772B782B9FAB775D3E62DA3DD73504DD62900` | `71E21AA94A0B3D696809C01070543F8E2DC2ED5E1AEA42D8764268B87C51FFF8` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `C6001299CE5C5807B45452F10CE8B0C8D60C223A060FFC0C628FB2A23FF21231` | `BF8CB25FE0DCC0F9BC8994F3C2E05F7FA06A3C007C361457CA3FB35910C34DF8` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `CE66354DF5B554DCDFA86FAD114C6BAD258DC823649271884567AD8D14DE2A5B` | unchanged |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `1636DB544ED6E3E0BF7C8AB062A8319B01E731B0031B03C1E799FC49B7DC128B` | unchanged |

The P1 hunk adds only the SQLite rowid-table `TEXT PRIMARY KEY` nullability
fact and exact `NOT NULL` requirement. The P9 DDL changes only the
`attention_fact_id` declaration. The DID advances from v1.44 to v1.45 with
governance history and links to the acceptance and this review. P10 contracts
and accepted logical P41 semantics are unchanged. Owner hashes match the
accepted proposal and postimage manifest.

## Migration and verification boundary

Migration identity remains 0041,
`p41_submitted_decision_binding_attention`. 0041 remains absent from
`CURRENT_MIGRATIONS` and all runnable lists; it was not registered or executed.
The qualified 0036→0040 prefix prerequisite, empty-table creation, no-backfill
rule, and no-canonical-rewrite boundary remain in force. P41 recovery and P10
projection are not activated by this landing.

No production source, migration implementation, tests, database, build, or
daemon was touched or run. This review establishes design-landing consistency
only; it does not establish implementation or release qualification.

The review verdict was delivered by the independent reviewer in the task
collaboration channel. This record captures the verdict and evidence; it does
not claim to be an artifact authored by the reviewer.
