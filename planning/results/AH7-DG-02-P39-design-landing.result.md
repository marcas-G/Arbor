# AH7-DG-02 / P39 Owner-Contract Design Landing

Status: **OWNER CONTRACTS LANDED; INDEPENDENT POST-LANDING REVIEW PENDING**

This is Phase 2 of the isolated P36–P38 → P39 governance integration. It lands
only the exact accepted AH7-DG-02 logical package and its reviewed P39 physical
supplement. No new semantic choice is made here.

## Fixed package, authority, and review

| Item | Evidence |
|---|---|
| Accepted logical proposal | `planning/proposals/AH7-DG-02-reconcilable-tool-reality-fixed-decision-draft.md`; LF SHA-256 `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` |
| Accepted P39 physical supplement | `planning/proposals/AH7-DG-02-P39-physical-schema-supplement-draft.md`; LF SHA-256 `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C` |
| Acceptance / authority | `planning/results/AH7-DG-02-governance-acceptance.record.md` and `planning/results/AH7-DG-02-P39-physical-schema-acceptance.record.md`; user's standing manual-governance delegation relayed by the user-designated root agent |
| Independent pre-landing reviews | Logical proposal Blocking=0; fixed P39 physical supplement Blocking=0. Physical review explicitly leaves Windows/deployment qualification open. See `planning/results/AH7-DG-02-independent-audit.result.md` and the two acceptance records. |
| P36–P38 integration baseline | `planning/results/governance-P36-P38-integration.result.md`; Phase 1 HEAD `a436866240f7f316249d8451395161c0a6efc035` |
| Design version landing | System Design v1.15; Detailed Implementation Design v1.40 (after P38 DID v1.39) |

Authority accepts only the two hashes above. Implementation, migrations,
production code, tests, Windows deployment, and actual reconciliation remain
separately gated. Post-landing consistency review is not yet complete.

## Selective planning-package transfer

The DG02 proposal/review/acceptance chain was selectively cherry-picked from
the AH7 governance line into the Phase 1 tree. These ten source commits contain
only planning proposal/decision/matrix/result records; no old baseline code or
owner-document blobs were transplanted:

| Source commit | Target commit |
|---|---|
| `c68aad4b2c4f8f577ad69f70f7c04762e14e516a` | `8fa8c11` |
| `cd25a0ca9a0a8559d62064b2b46ad69b268a6bcc` | `1666522` |
| `e049981357211b99073fb13673ef25d306499f24` | `c728d17` |
| `ebe3bac0716175a880c65b6405e6145c8d897186` | `445b738` |
| `f2ac7d7ad8eddf0771d8170d5d5e920a2c0e990d` | `637fe92` |
| `e67425057fba408d9c1856bf1f6f7dee115707a6` | `1716ca1` |
| `9240dce23160395f887f3277305383b9078b14b6` | `26f633e` |
| `72cc41f87ee68d795e5d378e9c83ab8984a56c49` | `7d0c639` |
| `701c01470dbb5e06c509e0a302d8330fcf7f7b2e` | `015de9a` |
| `ff95902da06896c7e62e0ff9b5e6cc75e6c6a531` | `79b7690` |

The accepted proposal contents remain byte-for-byte/LF-hash identical to the
accepted source package.

## Proposal-to-owner mapping

| Accepted contract | Owning landing |
|---|---|
| System-level purpose, reality/evidence distinction, Stop vs in-flight accounting, 79th system invariant | System Design v1.15 governance record, §6.5, §10.4 and invariants 78–79 |
| Durable ADT/proof outcomes, P39/user_version prefix, sidecar deployment envelope | DID v1.40 governance record, §6A.7, §9.3 and §9.12 |
| Exact source identity and ToolResult/Observation/Action/cursor convergence | P3 `00` / `08` |
| `ReconciledNoEffect`, proof/unknown unions, replay/Stop ordering, approved binding, P39 invocation/attempt/fact/selected-fact schema and fences | P4 `00` / `01` / `02` / `03` / `06` / `08` |
| Existing P9 event/recovery ownership and deterministic crash/finality/Stop matrix | P9 `00` / `01` / `02` / `04` / `07` |
| Existing P9 event → ActionRequired Attention source/dedup/target/summary and retention-bounded rebuild | P10 `00` / `02` / `04` / `05`; no new DTO fields, ViewId, marker table, or transport endpoint |
| Ordered P36→P37→P38→P39 migration prefix, P39 SQLite operator sidecar schema, maintenance preflight, crash/error/platform contract | P1 `00` / `04` / `06`; P4 `06` owns tool DDL |
| P39 blocker means no conversation/service/AgentLoop start and no synthetic chat outcome; release seams | P14 `00` / `02` / `05` |

Historical shell@2 remains exact-version history; unrestricted shell@3 is
NonIdempotent; only an exact constrained profile may be Reconcilable. P4's
closed proof outcomes and selected-fact settlement rules, P3 source identity,
P9 existing escalation event, and P10 event-retention boundary are not expanded
beyond the accepted package. The transport surface remains unchanged.

## Migration/deployment boundary

The target order is `P36 → P37 → P38 → P39` / `0036 → 0037 → 0038 → 0039`.
In this Phase 1 integration tree the P36, P37 and P38 **owner contracts** are
integrated; migration implementation/registration for 0036–0038 is not.
P39 depends directly on P36/P38 and is also after P37 by the ordered
`user_version` prefix. It cannot be independently implemented or released.

The green `C:\Arbor@f80` candidate remains at P35. It has neither the P36–P38
owner integration nor P39. This landing does not change that tree or the main
checkout.

The reviewed P39 gate preserves these distinctions:

- Before any pending P37/P38/P39 DDL for an eligible v36–v38 primary, the
  maintenance process validates the explicitly operator-selected
  `--migration-block-report-db` local SQLite sidecar, quiesces all primary
  writers, and takes the read-only P1 `BEGIN IMMEDIATE` blocker snapshot.
- An active P36 `NotAdmitted` row without complete binding is reported to the
  immutable, stable-key sidecar, after readback the primary snapshot is rolled
  back, and the process exits `P39_LEGACY_DB_ISOLATED` / 78 without service
  startup or committed primary row/schema/approval/P3/user_version change.
  That DB cohort remains isolated pending future governance; no binding is
  fabricated, approval refunded/transferred, row deleted, or invocation
  retried. This does not claim human recovery is closed.
- Sidecar and primary lock order is primary→sidecar; uncertain sidecar commit
  is resolved by key/hash; the operator retains the sidecar DB and its WAL/SHM
  together and owns backup/retention. Typed path/schema/I/O/durability errors
  fail closed.
- Windows deployment remains blocked until the actual `@effect/sql-sqlite-node`
  / Node VFS, every supported local filesystem, and hardware pass the reviewed
  process-kill, I/O-fault, VM hard-power-off/reopen/integrity matrix.
  `synchronous=FULL` is conditional on VFS/OS/device flush behavior; network
  and unknown filesystems fail closed. This landing asserts no such
  qualification.
- P39 DDL enforces immutable RecoveryBinding/attempt/fact identity and
  same-invocation/same-attempt `selected_fact_id` provenance for reconciliation
  terminal Success/ExpectedFailure/ReconciledNoEffect. Historical P36 terminal
  rows remain unselected; historical MayHaveStarted has unknown admission time
  (not `intent_at`); old profile-less facts retain null binding/profile/key
  with the accepted `LegacyProfileUnavailable` provenance and canonical
  `ProfileUnavailable` reason.

## Owner-file LF SHA-256

All hashes below are SHA-256 of UTF-8 content after CRLF/CR normalization to
LF, without a BOM. These identify the landed owner files for post-landing
review.

| Owner file | LF SHA-256 |
|---|---|
| `docs/design/02-system-design.md` | `1A1D2A584B2837B21B3AEAEBE0942F0E68A21F2BF1ACB73493FF0B8F6B01C79C` |
| `docs/design/03-detailed-implementation-design.md` | `84317FDBD7908DCD52A869E29954130C86CB6C286C50FC2F54CA52A3111F57C4` |
| `docs/design/implementation/P1/00-contract-index.md` | `56FC4944165E1C9E75D2DDB4C149FF7B842890B292953AB381995D2848A395E9` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `CCA3E2E90D10487CDB04B4290BF7B7536BEE68DC6925D8D29377CBAED217B317` |
| `docs/design/implementation/P1/06-recovery-matrix.md` | `D3441A97B9660B6E5F4817E279D22BD88100841CEE54650ABE8BB4574B46056F` |
| `docs/design/implementation/P3/00-contract-index.md` | `EA0B757F843FCB74BD3BEB29EC92D26675C72FA349467B49ECBBC661A577402A` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `5C9204B24946FFCD224F928174C9A65A1A27D2F981FDCEEF4DC8F655923F0099` |
| `docs/design/implementation/P4/00-contract-index.md` | `888C82F5CBD4E8E6DC87E772AEAA39BEFEE7426C0037B7F6DDC9378866999D50` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `CFD422500592AA2CD5E8E41C224363080FF371E714F590D4CC54B93007B31ECC` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `EE88DE8E296DCA1C754386B555639E4CD20E5A4DAAAE31A2C57798CE0135A28E` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `4F2DD6D0DA2433433E0146AB37459E4080959644237F997C079C25FA029CE2E4` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `1287510AFACFF59AB61D66CCAE71662962BF16C6576B93D4DF360D85152D41FF` |
| `docs/design/implementation/P4/08-minimal-tools.md` | `6B0A6D59F75202DEDB62CBF8138E4BAF42F31E4D014B24F36B3BA3643F420BDD` |
| `docs/design/implementation/P9/00-contract-index.md` | `E922B06871498E9BA4980C9FD6A81EACAA36D2E0800AFFAF775353AD739681F8` |
| `docs/design/implementation/P9/01-recovery-visibility.md` | `5CFC498074445A4A8D14C520BA43428FE6C4DBA38ABC655AF17B4FEC9411AB7A` |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` | `A7966EE609DD70DE6C17658A43D30C35263218BA78C24F77694B0D88894FF4A4` |
| `docs/design/implementation/P9/04-provider-tool-hardening.md` | `36F917E00241FEAF831354F4A7ADD061DE682F29403AA4245CBBEE7EE0F93865` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `7FA44B79AC140630CBE2EDEECE018D8EF8B392A98B358DFA94D5577430A8A560` |
| `docs/design/implementation/P10/00-contract-index.md` | `2719B51F132EF8EDC7BF9F6D3205C27D42988A19BDAC8650DCCB34A75A4995DF` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `B59E08D6BC275F52C9E2D136053C4325114DE3CF5FA326E70D0D6F2731661A0D` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `0528BD973C8B8121474838D498B2137F302C565BED95208E0BA6A09FA0F643C6` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `EE5847E333207670376C78FF5A8BEE849D6124CAEFF3B828E95471A3435384D3` |
| `docs/design/implementation/P14/00-contract-index.md` | `6561A960E682D66FC68C7B90618D17A5E08D313BABA8CDE7BED716E0D1560644` |
| `docs/design/implementation/P14/02-conversation-execution.md` | `E0C92114157DD456178918327919C721B7DFD54D5993F174F8807E2BB1808566` |
| `docs/design/implementation/P14/05-acceptance.md` | `80A66F6B4CDEBB1AF428C277C4CDF9EE51EB7EF9C23868870F917F070BECE7E7` |

## Verification and scope

- `git diff --check`: PASS.
- Proposal LF hashes: both accepted hashes re-computed and match exactly.
- No tests, builds, migrations, database mutations, production-code changes,
  or deployment qualifications were run.
- No edits were made to `C:\Arbor` or the green integration/main tree.
- Implementation authorization remains OPEN/separately gated. Windows release,
  affected legacy-DB disposition and P39 migration qualification remain open.
- Independent post-landing consistency review: **PENDING**.
