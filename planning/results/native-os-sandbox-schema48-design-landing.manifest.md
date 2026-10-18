# Native OS Sandbox schema-48 combined owner landing manifest

**Candidate base:** `2a5f0ab4605c316c8bfc0c5db1b54172e39c3d46`
**Branch:** `codex/native-sandbox-schema48-landing`
**Working tree:** `C:\Users\ThinkPad\.codex\worktrees\native-sandbox-schema48-landing\Arbor`
**Landing scope:** accepted design owners and planning acceptance/manifest records only.

## Package provenance and semantic rebase

The accepted V1/V3 source landing is `cbb541c11aa7029e23b027d4e2b257ada2b83b34`;
the V5-authorized V4 source landing is
`ed8c343724d00bb81c64db33f50943cc7386d5c5`. Neither is an ancestor of the
candidate base. Their accepted source proposal hashes and the later fixed-plan
acceptance are recorded in
`native-os-sandbox-schema48-design-landing-acceptance.record.md`.
Side-branch owner files were not copied wholesale. Accepted additive semantic
hunks were applied with `apply_patch` to the current candidate owner bytes.

The technical rebase is:

1. Preserve current Scenarios v1.4 / System Design v1.19 / DID v1.52 content,
   then advance owners to Scenarios v1.5 / System Design v1.20 / DID v1.53.
2. Preserve accepted V1/V3 process-boundary, profile, CAPA authority,
   issuer-provenance, decision/event/receipt ordering, provider, UI and
   recovery semantics in their existing P1/P4/P5/P9/P10/P11/P12/P13 owners.
3. Rebase the old side-branch storage sequence to the fixed schema-48
   sequence: 0049 (`requiresUserVersion=48`) owns grant provenance/revision
   normalization and the fixed immutable `SandboxPolicyDecision` table;
   0050 (`requiresUserVersion=49`) owns the V5 unavailable fact, durable
   queue/marker and exact decision-identity FK. The old 0043/0044 identifiers
   and signatures are not carried forward as current-main identifiers.
4. Retain the accepted WorkBlocker P2 owner and DDL. No descriptor is
   registered or activated by this landing; the dormant P43 draft is rejected
   as a schema prefix and must be reconciled after 0050 before any later
   implementation/registration.
5. Semantic overlap is resolved by the accepted fixed schema-48 plan: P1
   decision storage is added to 0049 and 0050 facts bind to that exact
   decision key. This is additive to the existing schema-48 P39/P41 owners;
   no owner semantics are replaced. No unresolved semantic conflict was
   observed.

## Owner preimages and postimages

Preimage is the Git blob ID at the exact candidate base. Postimage is SHA-256
of the final Windows worktree file bytes. The separate landing commit records
the final Git blob IDs; an independent post-landing review will record its own
commit and findings.

| Owner file | Base blob | Postimage SHA-256 |
|---|---|---|
| `docs/design/01-scenarios.md` | `5ccf22b4c525abca6bf84f62c339d22c01317236` | `ED04CA06142FBE1046B1172C06A0C0BDD29EAAFEF2A7A112C92AE27B0B2DBFD2` |
| `docs/design/02-system-design.md` | `d00f78cf76e406e073cd18a84d7e2a095319f0f8` | `138D2FB500A3C48F8A2492CA74918FA9D61226AA3CE2310052529048E9C144B3` |
| `docs/design/03-detailed-implementation-design.md` | `91449d6d7c73f3e8a41c5169c91d7fc687cd3212` | `0033E93E0DD9FAC6AFD96562B6F8D03E4BAA6FAF340117BC6EE78E289DB93806` |
| `docs/design/implementation/P1/00-contract-index.md` | `93ec00837ef02b44d41b939127f89c84dda19210` | `437B8C751E0157681EB8ACB68923C6CDE98EB782524BFF12075401CF12017703` |
| `docs/design/implementation/P1/01-command-contracts.md` | `2dca0c9c591fa342c60b9e942a79c868a92f93d5` | `77F1119B1629FA9F1B08080E374DB619DD107A83056CF3D777D1F460A2CCC12D` |
| `docs/design/implementation/P1/02-port-contracts.md` | `e76ccc8569eef421ec51e4a8a0eb5feef5ce8a45` | `82D45F75AAA044D8A8D2EA52A47A53234194BB6440F4C9961D350D05D36104A9` |
| `docs/design/implementation/P1/03-transaction-model.md` | `94d7278ff8247ba5360177ff76836214bae7a113` | `C7E780ECDF4513FB62584F6FA942B649E3647E52AE16756C4B1514FDA63C7E5D` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `fb984a836a8371df92830094da1a4e3976bef8ff` | `2DFB3D37A423281E8705761CABBA05CFC04109172346D48E4565BEC9D8598108` |
| `docs/design/implementation/P1/05-event-journal.md` | `a3fdead9905f5ff56dd629eeb28e5e7a4fbc5df3` | `D38D401096611419DBBA58E10AB0209DB8F676BD6181866248DAC129ACBFC327` |
| `docs/design/implementation/P1/06-recovery-matrix.md` | `e7bfa344bd9b14aff621d3e75e6520dca0f84843` | `CD924B56A44CC7997AB0A760874856286F739E86B89C3B13359F5061E02F3E3F` |
| `docs/design/implementation/P10/00-contract-index.md` | `097fe2b813b493509eed58548a8b06faa1c9f101` | `3CA7D64ACC99285C7B58DCC2180AEE8A475D4EAB8896640AA4D79192FB72AE6A` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `d8a6153fab56a82b7fcd8b851c274f859b6d53e4` | `8BE246D8DA80A58EF563E0F590D3363CF94B8D9EEA2C50088582DCA899E4CFE7` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `f418a85f3821045a7e60f9ccceea7d4abd1eb328` | `52738BCE09FB49C36F9770FB2E4E18C2DF448F53977C02CA2F4CF1FFAFC06FC3` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `4e16b79297820bfd7d695f221116d495d8f9f302` | `C527CC47B010CC7B22FB7725AA6328570BF4A1C7C18C1B62266D686C688112DA` |
| `docs/design/implementation/P10/07-acceptance.md` | `7a969e767408273468d8f07a156eb4b929b2ab32` | `5F1E036D8658A76E1B52DE9C5A4E20858E199DEB5420CFCE5C5DD5B40BAF8B1B` |
| `docs/design/implementation/P11/12-sandbox-handoff.md` | `0a9b7cc61f2eb2c08278be4f6d05bc48c951c59f` | `A9E3CC0C83249A9441C132BAD1C5FF2B84C5A98CAAB678E226A49A23C2F0A082` |
| `docs/design/implementation/P12/00-contract-index.md` | `946cb8ed958cfab4531c009b259ec1c528f1b0b0` | `E112B6E461E63A01C37A617B374EC28F91B9ED070BD94BB0FFB0C5B8BEF2BB6A` |
| `docs/design/implementation/P12/02-authority-resolver.md` | `dd0b92767f53e7b6ddd99560fa2eb51a40b64c44` | `71CB00C7AA9BCA9B925A872224A1F0A09025D2F5D149E29834D802518F5A5F67` |
| `docs/design/implementation/P12/10-transport-shells.md` | `879fdbc209cb2e086a102f83c46e2c92c4db202a` | `512EC61882014E3C54B75083ED57FA9DB57D70E35EA780912305421CEEAA20EC` |
| `docs/design/implementation/P12/13-security-performance.md` | `1c91d0f004f681d9a7bb5e64a1b4ec21a02257dd` | `790042FACE2FB8F9CF3C474EE79788343891AF715600084884429BB40743C95D` |
| `docs/design/implementation/P12/14-acceptance.md` | `743c06be9c74417f49bcca7c898f3d5e3dc9c97e` | `1B1D70849DBAE1D824F12E9722570A95CE77B7FDBE3B79BBB31DBCC8256DB06E` |
| `docs/design/implementation/P13/00-contract-index.md` | `e866efbc632248ac1285c62026e1da4d271e1914` | `52276EA00DB868C26FCA7889A54DF68D9BF8C8F5E438ABE9AEAC3E1B192CAB9C` |
| `docs/design/implementation/P13/01-client-boundary-role.md` | `7ce63b68ca564b69e14e83e640fa487468a5df45` | `31D60D16D824A735E412D64E7E94047402CBCB3C5B81FBFB2F8AA6D58CD1EC5F` |
| `docs/design/implementation/P13/02-command-exposure-matrix.md` | `2a1462ddca80b64c230b419b5f109c3098fbbba5` | `3C46E5D41F701581E05741108DB58DAE2C238BF3091F0B6A195A191F4D28C958` |
| `docs/design/implementation/P13/03-view-rendering.md` | `7e129099b6b8fdefa20f77e4f48cda6bfa61f6f8` | `BD845AD616EFAEB3386E4108035A573F34D1578186E137C1675F79790533003F` |
| `docs/design/implementation/P13/06-acceptance.md` | `1310f530777cceb4d5e8b04deb648d3f37e8339c` | `787D372B61D756B896BBA9E6F0829E841AFCA0C4DF652A681292DE047D442639` |
| `docs/design/implementation/P4/00-contract-index.md` | `eb6b5911c67ab42b89f757560c1176685f6192ce` | `F17C68EF9B2968C372B6021F63934AA7C58F60E3A870CF70D1AFEAF5852EE1E5` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `e54dbd78385cc8a6acf8cc914f6c72c21299e8a4` | `BEF2B448FD4A57B286698A181639D26779182CDE3F3613FEDE3F041559C39018` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `bd6d50876ecfaa9011313b1ef33c2352b14ec064` | `DBE9A21823BC9A9AC77A6CE0B7E34388BCD566A2060646787AACD92F8EF134BD` |
| `docs/design/implementation/P4/04-sandbox.md` | `5ada6262b80e9e37eec55587cb552701bf6e9ac4` | `1A5A40609FE94DF2E9485165C546BEDB63342DF68E74FA939476EA8371D7B3FA` |
| `docs/design/implementation/P4/08-minimal-tools.md` | `aa8a491e5cfe8bf8ac09d57ebf8deb8a30eaff0c` | `BF2705ACA1AEB1F57C2EEA69E1C4791EE989928E3BBA991369DF54FFE71C28EC` |
| `docs/design/implementation/P5/01-composition-root.md` | `fd745127eb9569b6579b581c208993fbadf587e2` | `B30335245755921210AB6A5E916BE5F2F214CB9340925451CA8EB103C2FEC294` |
| `docs/design/implementation/P9/00-contract-index.md` | `b6f0f51d7f47ce7fe35bfe2ccecb084cf7255b02` | `A545BE870E311350317A0059D2812C34C4E65E8C3B200F9C23A33E3C261C3423` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `fecfbd9c22730f40f00c1ce89f1c500f936f8f97` | `32F6915D9CA98DE617F7C90113F66E35FEDCAFA78B726C2086B1D980A8FCE8EA` |

## Post-landing review boundary

The accepted owner changes are a design landing only. Required read-only
post-review checks include exact cross-owner command/authority/event/receipt
order, schema-48 migration sequence and no activation, fixed decision DDL and
fact FK, P9/P10 recovery and freshness, safe UI/Attention projections,
Scenario/SD/DID version references, and complete accepted owner hash coverage.
The review must also verify no code, tests, migrations, database, deployment
or release files are modified. Landing-review findings and review commit are
recorded separately; implementation remains unauthorized.
