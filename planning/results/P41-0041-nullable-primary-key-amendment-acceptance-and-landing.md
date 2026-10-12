# P41 / 0041 fact-key nullability amendment — acceptance and owner landing

Date: 2026-10-12
Status: **accepted exact physical amendment landed; independent post-landing review pending**

## Decision and authority

- Decision: **ACCEPT** the exact P41/0041 physical amendment proposal.
- User token, recorded verbatim: `ACCEPT_P41_0041_FACT_KEY_NOT_NULL_PHYSICAL_AMENDMENT`.
- Authorization sentence, recorded verbatim from the user instruction:
  **“精确设计落地复审后实施/测试；不注册运行0041/升级DB/发布。”**
- Accepted proposal LF SHA-256:
  `BE7E9CC9F3528ADBA90EF67615FE1C24E92B5FE751782151882ACAA4531E2BC9`.
- Independent proposal review: `planning/results/P41-0041-nullable-primary-key-amendment-review.md`,
  SHA-256 `27740A79287CCBACB92D05983EF4661A048DE46440AD7883AAFDF3E4FC76A142`,
  final B0 / Blocking = 0 after a first review identified and the proposal
  corrected one diff-hunk marker issue.
- Prior accepted P41 physical package SHA-256:
  `589B4CD84298D5D418FF6A0DD143518EB5EB35654C324A9D9E6D0ECAF000F012`.

The amendment changes only the P9 fact-key declaration from
`attention_fact_id TEXT PRIMARY KEY` to
`attention_fact_id TEXT NOT NULL PRIMARY KEY`, and adds the P1 explanation for
SQLite's rowid-table behavior. P41 logical behavior, migration ID/name, key
set, recovery/event semantics, and P10 projection semantics are unchanged.
This exact physical correction was separately accepted because it changes the
bytes of the prior fixed physical package.

## Owner landing base and postimages

Landing base: combined accepted governance HEAD
`251b47de9b58a22d404345945d3b416ec2884c4f` (DID v1.44).

The P1 and P9 postimages reproduce the accepted proposal. The DID advances one
minor governance version to record this exact amendment; the P10 owner files
are unchanged.

| Owner document | Before LF SHA-256 | After LF SHA-256 |
|---|---|---|
| `docs/design/03-detailed-implementation-design.md` | `1990E2DCE2EAB46E700AF6FCE566496E525D29AE8B88747F3CEF61F6194897F2` | `CCA4CB967A0FD45D4756E7DB2175E494956E06B4E0A55BCEE1619EE5552B3C17` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `927FF7273C9C90133E796E1FF9A772B782B9FAB775D3E62DA3DD73504DD62900` | `71E21AA94A0B3D696809C01070543F8E2DC2ED5E1AEA42D8764268B87C51FFF8` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `C6001299CE5C5807B45452F10CE8B0C8D60C223A060FFC0C628FB2A23FF21231` | `BF8CB25FE0DCC0F9BC8994F3C2E05F7FA06A3C007C361457CA3FB35910C34DF8` |

Corrected migration SQL body SHA-256 (exact LF body, no template delimiters):
`8B5908A58CBC9F75B8188DF4FA6D22481F60B028581A603B022F1D883373846A`.
Descriptor fingerprint SHA-256 is computed over the three LF-separated lines
`41`, `p41_submitted_decision_binding_attention`, and the corrected SQL body
SHA-256 in lowercase hex, with no trailing newline:
`1C4B30B9FC08569C8B50A9333EA115562A2AC93EE81CC869CDA97D5FE75149A1`.

The combined v1.44 governance manifest remains historical and unchanged. The
narrow v1.45 postimage manifest is
`planning/results/P41-0041-nullable-primary-key-amendment-postimage-manifest.md`.

## Migration and operational boundary

- Migration remains `{ id: 41, name: "p41_submitted_decision_binding_attention" }`.
- 0041 remains absent from `CURRENT_MIGRATIONS` and every runnable list. It is
  not executed, and no existing or preserved database is read or upgraded.
- Preserve the qualified 0036→0040 prefix prerequisite; registration presence
  alone is not qualification evidence.
- Keep the migration additive and empty-table-only: no historical backfill,
  canonical-row rewrite, P41 recovery activation, or P10 projection activation.
- No production source, migration implementation, migration checksum manifest,
  tests, build, or daemon is changed or run in this design landing.
- This landing does not claim implementation, equivalent-database test, AH10,
  P41, or release qualification complete. Those actions remain within the
  separate user authorization and prefix gate.

## Verification boundary

An independent post-landing consistency review must verify the exact owner
postimages, DID version/history, SQL and descriptor digests, and unchanged
registration/activation boundary before this landing is closed.
