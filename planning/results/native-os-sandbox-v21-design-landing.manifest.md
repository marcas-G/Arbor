# Native OS Sandbox V21 design landing manifest

**Accepted token:** `ACCEPT_NATIVE_OS_SANDBOX_REMAINING_RUNTIME_CONTRACT_CLOSURE_V21`
**Accepted proposal SHA-256:** `5CF4E41F1940F7ABB6C61D5B963A9E9D687D967AC4C72EE7A31E18424873486A`
**Base commit:** `8cd0a94653f1278a194cf23e63503bf154885373`
**Branch:** `codex/native-sandbox-v21-owner-landing`
**Post-landing review:** pending; separate and read-only.

## Owner reconciliation

The V21 amendment is applied as a narrow forward-port to current schema-48
owner bytes. No side-branch owner is copied wholesale. Owners outside the
changed semantic surface receive compatibility references only and otherwise
remain unchanged.

| Owner | V21 landing responsibility |
|---|---|
| Scenarios 1.6 | User-visible pause/Attention behavior; no change to S1–S4 domain goals |
| System Design 1.21 | Read-only RecoveryBinding failure classification and derived Attention boundary |
| DID 1.54 | Cross-owner P9/P10/API rule, exact corruption and timestamp behavior, authorization corrigendum |
| P1 | Existing RecoveryBinding bytes/hash and schema/event/receipt contracts unchanged; no new persistence |
| P2 | Existing same-Execution pending/lease/Stop behavior unchanged |
| P3 | Existing Pending action/ActionsInProgress and no-observation/cursor behavior unchanged |
| P4 | Immutable RecoveryBindingV1 remains sole proof authority; no repair/rebind |
| P5 | Composition/config wiring unchanged |
| P9 | Read-only RecoveryBlocked classification; no P9/P40 fact, event or marker |
| P10 | Per-query derived source; exact identity, `intent_at`, safe summary and integrity behavior |
| P11 | Existing resource/environment resolution contracts unchanged |
| P12 | Existing DTO transport; no endpoint or Problem-category addition |
| P13 | Safe Attention row rendering; no repair control or raw evidence |
| API | Add non-persisted `AttentionSource` literal only |

## Owner preimages and postimages

Preimages are Git blob IDs at the exact base commit. Postimage SHA-256 values
are final worktree file bytes; Git blob IDs are fixed by the landing commit.
Independent review records its own postimage verification separately.

| Owner file | Base blob at 8cd0a946 | Postimage SHA-256 |
|---|---|---|
| `docs/design/01-scenarios.md` | `0173b9e983d6209b11a0d503e3687626091e57b9` | `7A4AD6C0E9CFEC8F3408F81DF9A02FFBDDDFD2F1E42FA810CC5E40BD9E3A28E2` |
| `docs/design/02-system-design.md` | `58a70e771481a2edd2fd0dfd316185009bf87b76` | `597C90B5B75D35C6058EDEDAE1923DFF441CC355CA435C2B9C31EE5C29730842` |
| `docs/design/03-detailed-implementation-design.md` | `bb906dd67752dc0b96cebce97c3b877d3ce06043` | `DB945A9BC03066205939F73B7D42F9381797D4FBEC5EAA98E5FBA93B79BF74D2` |
| `docs/design/implementation/P1/00-contract-index.md` | `729bdf55d7f9c05bda3ba4c8b68095745cf047fb` | `6A573FEC19B934AE9BC89B06DBBF095D101EF52AE2D7073FB9C3BF353A2A0ABD` |
| `docs/design/implementation/P2/00-contract-index.md` | `fcca3d72422d8161e562e16cbf031ce97e077d6f` | `7D0C491FF7871BCD25DD8426A0D5AF18F69CB19ACC621AEFE04DF02DBEF6620D` |
| `docs/design/implementation/P3/00-contract-index.md` | `b519e60b416e37fb107bc771a6963080192f76c5` | `AA7CF5AE2C937658B3DB0D65F86757BDFDD1BADF747C329589D8638BF0687A7A` |
| `docs/design/implementation/P4/00-contract-index.md` | `e495840fa64ae7c4a373b1d2297782fd78ccea10` | `450D3192755060123BD02C920CD58DF806B4F685DCA7CA902EFE8BE0523A1732` |
| `docs/design/implementation/P5/00-contract-index.md` | `462aec7bf94ad67c82bf1e1c06c75721168f3c9f` | `99A310C9DE4091F607C8A31D5E55734D876C7C16A7E84646C8A8FAC616C11F3A` |
| `docs/design/implementation/P9/00-contract-index.md` | `75a2647d2d17a2e15de8e2166849e7557dda872c` | `AE9DC929D781054C45F41600F1F60CF15D1D243D7E3F90CBFE22382E33A5C7B6` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `c9ae6e23d66529f93f5259e74f9aa3c0c6970df7` | `740A2C5FC342058C0E6F0FDCCD7C8D97E77F223E35B46161A5EC071BBB472FF6` |
| `docs/design/implementation/P10/00-contract-index.md` | `eeb462bef439726f86bcbc3995be701df5c56406` | `E527A786F6513B9D14D260E42C4A2F635876126A166B4E3778921616EB000141` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `b867384db6e1f7b41ddc660dc991893fbce3fbd1` | `6C25D3AD8CDEE0931FB35454EA963D941B22AD50643B13B763FDA0FF9BDAD3B2` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `8e1b3f46e1bc9154b875b068c2e8a2191a2d3893` | `F99DA64735FC97B822C0BFB44AEA92245A080BFE68E56674A91623D4BD21B148` |
| `docs/design/implementation/P10/07-acceptance.md` | `786cce8dd80c082ae419a1253faf40cb800fe72a` | `FFC424BAB6C42BD3FF747AD7F73A3D0A3982B1B225116400447FC8294E2368F2` |
| `docs/design/implementation/P11/00-contract-index.md` | `201a14ce3671f44fd4c15a1cc74a6df50f7d0955` | `B5D87FD8C4577ABFAA91481D1BFE40098F9B8E0FB8494948EB724EF289F58D43` |
| `docs/design/implementation/P12/00-contract-index.md` | `b5f08defce7174081e7b9c718fa8f99d9c99b009` | `1E753B654F131DD459A34FEF83BB61D0E2C8AE4F5415C5BF92D1CF8BCA0C5CE5` |
| `docs/design/implementation/P13/00-contract-index.md` | `e7ce1c550b939d72cb17cad283c8481db68a913b` | `F1FA1E9AF3B0FC6CE529EC478F1995FF772410EF27ABEB9D3121B4277623FCAE` |
| `docs/design/implementation/P13/03-view-rendering.md` | `cb8740c4ba0585f683da4d3164f9ff6499bdc655` | `52D1C06F12BF7B3240B9430D86E5E8B46D6F3FCC28ADD1873BE914AF6208F624` |

## Governance record hashes

| Record | Raw SHA-256 |
|---|---|
| `planning/results/native-os-sandbox-v21-acceptance-and-authorization-corrigendum.record.md` | `2E54F5E6ED1AD6FB8799843C36821E090AFAEE79ACECE39BA8CAE74427DF428B` |

## Verification boundary

Before commit, verify `git diff --check`, owner/hash coverage, current
references, authority/event/persistence boundaries, P9/P10 semantics,
DTO/source literals, version consistency, and absence of conflict markers.
Independent post-review must verify cross-references, no-P40/no-persistent-
Attention boundaries, and absence of code/tests/migrations/DB or release
changes. Implementation remains gated on that review.
