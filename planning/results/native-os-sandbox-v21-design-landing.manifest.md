# Native OS Sandbox V21 design landing manifest

**Accepted token:** `ACCEPT_NATIVE_OS_SANDBOX_REMAINING_RUNTIME_CONTRACT_CLOSURE_V21`
**Accepted proposal SHA-256:** `5CF4E41F1940F7ABB6C61D5B963A9E9D687D967AC4C72EE7A31E18424873486A`
**Base commit:** `8cd0a94653f1278a194cf23e63503bf154885373`
**Branch:** `codex/native-sandbox-v21-owner-landing`
**Post-landing review:** pending; separate and read-only.

## Owner reconciliation

The final accepted V1–V21 contract chain is forward-ported to the current
schema-48 owner bytes, including the complete authority, command, provider,
recovery, projection and UI contracts. No side-branch owner is copied
wholesale; each section is landed on its semantic owner while preserving
unrelated later owner text.

| Owner | V21 landing responsibility |
|---|---|
| Scenarios 1.6 | User-visible pause/Attention behavior; no change to S1–S4 domain goals |
| System Design 1.21 | Read-only RecoveryBinding failure classification and derived Attention boundary |
| DID 1.54 | Cross-owner P9/P10/API rule, exact corruption and timestamp behavior, authorization corrigendum |
| P1 | `01`/`03`/`04`/`05`/`06` exact human wire/CAS/fingerprint, resolver/receipt/transaction order, result/receipt/decision digest join; P1/07 unchanged; no new persistence/event/schema/envelope |
| P2 | Existing EGP `episode_revision` CAS mapping and same-Execution HumanIntervention park/wake; no new state or migration |
| P3 | Same Pending/NotAdmitted invocation and Step progression; no retry, observation or cursor mutation on policy interruption |
| P4 | Closed policy/network/effective-snapshot and target/basis codecs, process boundary, no-effect probe observation, immutable RecoveryBinding and no-rebind recovery |
| P5 | Closed authority/issuer/provider registry bundle, protected source/high-water, sanitized load/audit errors |
| P9 | Read-only RecoveryBlocked for binding proof; actual provider failure fact/time/lease/fence/no-reprobe contract |
| P10 | Exact provider fact freshness and 100/5s/30s queue/rebuild; derived NeedsDecision and RecoveryBinding Attention; DTO/barrier/503 |
| P11 | Real region-resolution and logical mount handoff to SandboxTargetRef/basis; no EnvironmentRevision policy dependency |
| P12 | CAPA authority, target codec cross-reference, transport Problem, exact T2/T3 rules/primitives/evidence matrix |
| P13 | Human-only policy UI, explicit FullAccess/Unconfined, NeedsDecision/Unavailable/summary-too-large and safe Attention |
| API | Non-persisted `SandboxRecoveryBindingFailure` AttentionSource literal, existing DTO/route only |

## Preserved full-chain audit evidence

Implementation audit baseline `f705a517f7f9e0bb46e527bb438d96beaea539b4`
is evidence only; owner bytes are based on `8cd0a94653f1278a194cf23e63503bf154885373`.

| Audit | Raw SHA-256 |
|---|---|
| `planning/results/native-os-sandbox-wave-c-authority-gap-audit-f705a517.result.md` | `A1EB042817CB6886405982A7CA17D790A0E325762ECF835A23C840A567A6772B` |
| `planning/results/native-os-sandbox-t2-t3-provider-gap-audit-f705a517.result.md` | `14E0B8D8D64A2684AE33FBE65CCF8F6A7BB7B19F05D6712555549146CF4FCDEE` |
| `planning/results/native-os-sandbox-wave-d-recovery-gap-audit-f705a517.result.md` | `412E79EC9CA466A397B8E698AFF195676300662934763E3CF0CC50268C33F7E5` |
| `planning/results/native-os-sandbox-runtime-gap-audits-f705a517.record.md` | `BB9D1BDE75397FCDCC8EFBE3BB19760A0F7A33644725E12976245356823A54C1` |

## Owner preimages and postimages

Preimages are Git blob IDs at the exact base commit. Postimage SHA-256 values
are final worktree file bytes; Git blob IDs are fixed by the landing commit.
Independent review records its own postimage verification separately.

| Owner file | Base blob at 8cd0a946 | Postimage SHA-256 |
|---|---|---|
| `docs/design/01-scenarios.md` | `0173b9e983d6209b11a0d503e3687626091e57b9` | `293B60C64B185B357E952CBB99371A2C72FA1B8710ADD0FB22507EE2D3A8FBA5` |
| `docs/design/02-system-design.md` | `58a70e771481a2edd2fd0dfd316185009bf87b76` | `4F181CFE5EED4A9DD75ADA4757BE3D8A1370787A9C194794004AF71EDF47F38B` |
| `docs/design/03-detailed-implementation-design.md` | `bb906dd67752dc0b96cebce97c3b877d3ce06043` | `C09439F7CF050D46A6061F0C29B2A8AE3252406B28A04339056B90F400443A9A` |
| `docs/design/implementation/P1/00-contract-index.md` | `729bdf55d7f9c05bda3ba4c8b68095745cf047fb` | `0AE44F30EF251263330FBEFDA2E100B3B82A05775AF7CE72C173B674FDE3BD81` |
| `docs/design/implementation/P1/01-command-contracts.md` | `099ee06b910b6ebf4bdb4dedbad1da03a395ed6b` | `7686CF5458B2E938DB6A44EC0FDB7A61B9759A09E13A2834B0D089E8F3859F81` |
| `docs/design/implementation/P1/03-transaction-model.md` | `ecf545aa241709df836c98615250b6d6231822ed` | `47856C81D7B669105D8DDCA78684D5E3CF140A7371B684AA37A23CF4987D9CF7` |
| `docs/design/implementation/P1/04-sqlite-schema.md` | `718339f5a5140b48fea466d6ba69cfe751de1399` | `9D17A799E01A20CB5EEAC78AFE9032E53EE9A22F0348917961A27965475D339C` |
| `docs/design/implementation/P1/05-event-journal.md` | `4520d5e2d6a69fcc32dee42b65d5a5fb4ab56f20` | `2D032CDB4D29AC74F314B577E16D4EB28F237C428CE152EAC38F0972E9D2873F` |
| `docs/design/implementation/P1/06-recovery-matrix.md` | `9a45a5ab9a4cd9797ae654c999ee047d8219ef07` | `BFDA5F44AFB71A6FEB0BE4D40091F87FCFEC3F2A1D69F26283DEDCF99A918654` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `b867384db6e1f7b41ddc660dc991893fbce3fbd1` | `E3AFDDF0AD6295EC5A3E3E43980BFD43CA86281517C9EBF5EECA2A9271EB0D53` |
| `docs/design/implementation/P10/03-effectivefacts-freshness.md` | `30f81f8c991f76c92c7e2df1711e3f0d14d76330` | `C6D62A82EE313C9A06181BB9B868E2DA535D4A0298909A3033E5CFD8234600F7` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `5f99f23a2fbed9cf2db507245a44237a55dbd80f` | `780132A55D807ABDE68267F316070617DB5526ADC5A95D05EA79F785251C7EDE` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `8e1b3f46e1bc9154b875b068c2e8a2191a2d3893` | `45FD0DC61216DBB6AA325E81555F1FCAC95DA0352B2F4F924F38B4EE053C6806` |
| `docs/design/implementation/P10/07-acceptance.md` | `786cce8dd80c082ae419a1253faf40cb800fe72a` | `E495633C0F88C8A90234719C3C969CC89FD7995753DA0297DF99C6B0DFCFE613` |
| `docs/design/implementation/P11/00-contract-index.md` | `201a14ce3671f44fd4c15a1cc74a6df50f7d0955` | `E6EB40A11CA9AD2FCF7CCC9B2C3799F4007052714A582EFFF0F367DA75A60103` |
| `docs/design/implementation/P11/04-real-resolver.md` | `4dcebb15ae5a2a56edf110c8bdfe5c2b37a23cf2` | `E67D1ECD9D42AAFF9C719B572753B72C890C21F960E9DA5406E88FBB06E54F5B` |
| `docs/design/implementation/P11/12-sandbox-handoff.md` | `a57d598bd5168136dc4e9ff9b80c874712e552d1` | `7C1433375544928B8AF7FE1DAC6EC97927F900C52581AA0D804B8C22EBA4F2A9` |
| `docs/design/implementation/P12/00-contract-index.md` | `b5f08defce7174081e7b9c718fa8f99d9c99b009` | `8F020278A8804FB0796339B6DB7BA4FBF014D26071CFC1A18856602AA12603F5` |
| `docs/design/implementation/P12/02-authority-resolver.md` | `cd39700a61f74d7ed353ed79d4587aab6032304c` | `24767F02E632087C15CAE0F435FC2F43DEEFE2E0ABD506B7C8F1EEE8EF928AE4` |
| `docs/design/implementation/P12/09-region-encoding-convergence.md` | `df2f17a61e3ebe26e75619559c6acf5755bd3630` | `61D46D68373DD26FA820A7ED26E0989C09A630F3CD6D961120F7FCAA16D74504` |
| `docs/design/implementation/P12/10-transport-shells.md` | `79f2a979f044977e2e2507db6c0fb8ce8457d45e` | `985291C26A9A4F9413E3FE6F8F89D1FF4AB5372181AAB2D6F05FCA9236F2CB8B` |
| `docs/design/implementation/P12/13-security-performance.md` | `08481413cec099f2a00175b4e49f72f711364af2` | `E902B1F254E247251B46739B079E1BABF63B3B826325480939C831DC47FED797` |
| `docs/design/implementation/P12/14-acceptance.md` | `02a349fb4d5c8447c99ad940698da99dab9ecf1f` | `A22B8CAB0BE3D59C61DA485D59E4F7EF2E6B81EA3C52F9D67A788F9FAD095ECD` |
| `docs/design/implementation/P13/00-contract-index.md` | `e7ce1c550b939d72cb17cad283c8481db68a913b` | `BF8759742210186F76A89BBA007E9DDCBA80B7D949906FE591F0EEF7901FAF81` |
| `docs/design/implementation/P13/02-command-exposure-matrix.md` | `0ef175222c8a93169a985665d21384910fc720d9` | `CEA2F42088846BF34A8B92C1CF8A1F2723EAD43541F3EF6784757F0E4A2E762A` |
| `docs/design/implementation/P13/03-view-rendering.md` | `cb8740c4ba0585f683da4d3164f9ff6499bdc655` | `BC02FDAF74A2298EBCB7410EC36B46A9D4A105436E236864E0C8A8F55D77A350` |
| `docs/design/implementation/P13/06-acceptance.md` | `7aad2ec67eab1802c648b84710440429c3fefae3` | `AAE8164010518FE9C557A28BAFC7F14F14C46C0788EF21E8120C1955C73BDE0F` |
| `docs/design/implementation/P2/00-contract-index.md` | `fcca3d72422d8161e562e16cbf031ce97e077d6f` | `17FD5689354CA938917C0EF56EF7C07836EE8C4458CB2C4341BD81CA9AFF42D0` |
| `docs/design/implementation/P2/04-sqlite-schema.md` | `5d685fbe35daa1e0e3e779a88ecd96da3de4c0be` | `FF39876061B8333F4E8CF5EA62B520B09A1278E23F443D18F0AD58E383D9A35D` |
| `docs/design/implementation/P2/05-scheduler-wait.md` | `afa9ea4728ede750cadf02edf4a93ef9e087e787` | `536C6CFF52C4A2305552D2C5BD47C560F3B6682D11BBF437B5D24CC94B854F6F` |
| `docs/design/implementation/P2/06-recovery-skeleton.md` | `1fba10211b82e64b0ff92474a82553b84874c9f8` | `9E1CD3F3FE8710990858794F082D1B9555BA912924CC42351197B529576C3091` |
| `docs/design/implementation/P3/00-contract-index.md` | `b519e60b416e37fb107bc771a6963080192f76c5` | `2F89FB8301CFBD78E3D1E1F5DE6776E7522D50BC33CC73E9EC3B77D5081716DF` |
| `docs/design/implementation/P3/03-agent-loop-driver.md` | `d5953877337458dcc082c87e28ef1d604cd6b133` | `DD327BFAC9EF0B3997B830B3E509DA6B6C23AC4A8A86D8A009C34FCCD1BA7233` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `fd6080fef31023116bb5c8897406544e2b96a1e8` | `2FD27025650B18E95C9DDB7C8B46A4365FF3F032B4907266F2DEF62466603D0F` |
| `docs/design/implementation/P4/00-contract-index.md` | `e495840fa64ae7c4a373b1d2297782fd78ccea10` | `4D6C8C0DB1E15B674F5BFF01699C2C09F57EDBA1B0D552DCA15F5805F554DB6B` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `315ff5e4aaae1f46cc99b979b9f05cba6442b6b9` | `447D4E20B7678B7312383E564A73F0AF138226EFCD9B97EE8F8376922588E678` |
| `docs/design/implementation/P4/04-sandbox.md` | `c1ac29db352583eea64693efacb8049464672e46` | `8DB673C7CE5ADC673E1595C7DEBF3DEAF7EE830309F73DCB1694A941B6C34722` |
| `docs/design/implementation/P4/05-resource-admission.md` | `8316a0ea722d7fb97abb50a86026a88ddf4d7fca` | `B60BB7083EC065C02766D1FB17029928AF1D7DD8FDD20410D08E131D782413A6` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `338562d6593eb4dc4cef4c7e1c804bfe0352a7a5` | `4978E353F84795D1B409DDACA10F1726A8146A85C9381E26FABCF95045276E69` |
| `docs/design/implementation/P5/00-contract-index.md` | `462aec7bf94ad67c82bf1e1c06c75721168f3c9f` | `6BE9C35781BE6B7DBEC8FBFBA2EC6ACDB73FE26F6F8E3A9B36569B14EBE66D19` |
| `docs/design/implementation/P5/01-composition-root.md` | `f1c5c8ce10478f3b3752b5d21fa313c36047559d` | `570BC787D1A7307DF00396B5165A8C51341A5B6E0BA05ABF6CFA0EBE527179FF` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `c9ae6e23d66529f93f5259e74f9aa3c0c6970df7` | `CFA8480B500AC74C3481672321F55D9AA4AE99D542214242E4E533669C4EF966` |

## Governance record hashes

| Record | Raw SHA-256 |
|---|---|
| `planning/results/native-os-sandbox-v21-acceptance-and-authorization-corrigendum.record.md` | `A188D09FA1279A65A745E92FED97402D684673E3E9A12560C9B50C969FB72527` |

## Verification boundary

Before commit, verify `git diff --check`, owner/hash coverage, current
references, authority/event/persistence boundaries, P9/P10 semantics,
DTO/source literals, version consistency, and absence of conflict markers.
Independent post-review must verify cross-references, no-P40/no-persistent-
Attention boundaries, and absence of code/tests/migrations/DB or release
changes. Implementation remains gated on that review.
