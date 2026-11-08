# AH7-DG-01 / P39-P40 Compatibility — Owner-Contract Design Landing

Date: 2026-10-11
State: **P40 owner contracts landed; independent post-landing review pending; no implementation/migration/runtime authorization**

## Accepted package and target tree

Owner-document landing commit: `4ea4187367c9ec634dd49d6f9beb3d8a5db601ea`.

The fixed source package includes:

| Package | Accepted LF SHA-256 |
|---|---|
| AH7-DG-01 logical | `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD` |
| AH7-DG-01 P40 physical | `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A` |
| P39/P40 compatibility addendum | `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830` |
| P39/P40 compatibility SQL/source/replay/legacy/kill matrix | `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35` |

P39 accepted inputs remain D0A logical SHA-256
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` and
D2FF physical SHA-256
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P39 post-landing review was reported by the coordinating Governor as
Blocking=0 / 25 owner files matched. That review preceded this additive P40
landing; P40 post-landing independent review remains pending.

The fixed planning package was selectively transferred without merging the
old f80 baseline: target commits `8bf7f23` (D0A), `6f163ed` (D0A acceptance),
`e45dd67` (P40 physical proposal/result), `2ac8acc` (DG03 Denied physical
compatibility), `3dbd195` (P40 physical acceptance), `0f0906e` (P39/P40 RNO
compatibility addendum/matrix), and `43f703d` (compatibility acceptance
record). The independent review verdict was Blocking=0 for the exact fixed
compatibility addendum/matrix hashes above.

## Landing disposition

- System Design advances v1.15→v1.16; Detailed Implementation Design advances
  v1.40→v1.41. Problem/Goals and Scenarios are unchanged.
- P1 `04`/`06` owns the global P36→P37→P38→P39→P40 user_version/startup and
  crash contract. P39 may be migrated only within the cumulative maintenance
  chain; `user_version=39` is maintenance-only and MUST NOT start Runtime or be
  released. P40 is entered at 39, commits version 40 atomically, and has no
  down migration.
- P4 `01`/`02`/`06` adds the same P40 v1 16 KiB hashed inline Observation
  envelope to five DG01 tags and the accepted P39 `ReconciledNoEffect` branch.
  The P39 row remains `MayHaveStarted`, `Reconciliation`, `Bound`, and linked
  through the same-invocation/same-attempt selected `NotOccurred` fact. Its
  P39 fact `result_ref` stays NULL; the P4 row/Observation `resultRef` is the
  separate P4 ArtifactRef; P3 bounded-payload hash/source identity stays
  distinct. DG03 `Denied/NotAdmitted` remains the closed reason-code,
  version-1 deterministic, NULL-evidence exception.
- P4 terminal reads/CAS losers fence before evidence reads; valid losers
  return only the P39/P40 committed winner. Legacy P39 RNO rows with NULL P40
  evidence are not backfilled, rerun or rewritten. A valid current generation
  gets `Missing`→RecoveryBlocked/P9/P10 for a still-Pending P3 action with no
  ToolResult/Observation/Action/cursor write; stale generations get
  ownership-lost only.
- P3 `08` keeps the exact source formula and atomic handoff; P9 `07` owns the
  immutable replay-evidence fact/event; P10 `02`/`04`/`05`/`07` and API/read-
  model owners add the closed source, dedicated marker, shared-offset and
  retained-horizon rebuild behavior. Failure code is internal; fixed
  path-free summary only is public. P4 `07` states Artifact bytes do not
  reconstruct missing Observation.
- P36 Denied/approval, P37 Deliver, P38 EA, P39 RealityProof/sidecar/
  RecoveryBinding/selected-fact and earlier migration bodies/checksums remain
  unchanged. No production migration implementation or registration was
  edited.

## Owner-file LF SHA-256

Hashes are UTF-8 SHA-256 after CR/CRLF normalization to LF, with no BOM.

| Owner file | LF SHA-256 |
|---|---|
| `docs/design/02-system-design.md` | `C88E8F0EA28406C01A897D52156A1991F6355188DC1811AA574278A41D6CB9B0` |
| `docs/design/03-detailed-implementation-design.md` | `73B2BD156A3F84EB474BBA8270DDCD7CBB3699E912CD59C2D2E444786502F92B` |
| `docs/design/implementation/P1/00-contract-index.md` | `C3D9E22DFE38760EDD00AB783FC39E4BB91CE4587CB3A8ED5186AE2F91301D07` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `BDE279FCEA77C414249EB0E6DE0C128536ADD97AE381B9FB3F6D1F9976C50CA4` |
| `docs/design/implementation/P1/06-recovery-matrix.md` | `FB4B61244AAFF86415FB1098275639E70F505597881BD810490F4ABD5ABC5DF3` |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | `54374B78B174C2668AA2EADA4E11E43FA9CA56017C874276D25A9783FA26C1AA` |
| `docs/design/implementation/P3/00-contract-index.md` | `A375F239FBB70B3F10BF58385DAC74B678E477DB5623F2E4DB399733924DFB31` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `22DBD648E3F7DDF6FB5F4B7DEE9EE850298176E64EA8260604ED9C2DD674836A` |
| `docs/design/implementation/P4/00-contract-index.md` | `A49987D7DFC28D50FB5F83197656BB3DF7535FE3E2FE82AE436074B067F9B9F9` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `272D1CE4A2A394414D00DC99EB00D7B8B119CE7F41209EF18B8C339E9B3D3E7C` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `899515E8F9659ECE37C41610FC8444D4AF5956463BCD68E504A82E5EDCB3E29B` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `4A5FE94A64BE886DBCAA56BEDD6486A1203363D35368BDC0E4CC2B9F88D4028F` |
| `docs/design/implementation/P4/07-blob-artifact.md` | `F81D0F804A6C0EB71339EC621B2FBB1E53AB6131A320A2DFA9E412A80F7DEB39` |
| `docs/design/implementation/P9/00-contract-index.md` | `A358D0D7BD0FC048A961805CAD522F084C452CF18CE46CF59A448AC545F74564` |
| `docs/design/implementation/P9/01-recovery-visibility.md` | `68AB413628E045C60F588EE064A9D588F3D4BF56F7C9FFFCC3A307D50892C0C8` |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` | `CB4FD3E2BA8C40C5F4751905DAF119127312950C965D53033A540F364D1461BE` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `D857CCF4EFF0270B08D319121A6718BC1325BC2E94168A29874527B0738BC58C` |
| `docs/design/implementation/P10/00-contract-index.md` | `5F9B09859B25818676E4B7F499BAAFFB27DFE34EF5BBCF5ECFE3876D54976C1D` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `0B475EA75E26DDB27E4F5B1B84AA67E62BF8A726CCD1FBF8510FDFEF2402D9E3` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `C4AD195921735340F428E8C902D1C332D7BD6403ACD235BEB0E2BAD1BDF5CD10` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `8B3810A5F8E3C6C4F14989607939668780C9F43421451DB5ECED28C12CC93F50` |
| `docs/design/implementation/P10/07-acceptance.md` | `3813F0CF27FC2B0E3ED254132FD52B96E7CB8EEE89F402E7F4F434429DEEC0B9` |

## Verification and qualification boundary

- Owner diff was checked with `git diff --check`: PASS.
- This is design-only. No tests, builds, migrations, daemon/runtime starts,
  release/Windows qualification, production changes, or pushes were run.
- The accepted P39 review does not cover the P40 additive owner clauses; an
  independent P40 post-landing consistency review is still required.
- The user_version 36–40 migration chain, cross-process serialized migration
  runner, P39 sidecar/Windows durability, and all AH7 runtime/crash matrices
  remain implementation/release gates. AH7 is not declared closed.
