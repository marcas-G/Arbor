# F21 / F23 isolated integration

Status: integrated on an isolated worktree; not pushed or merged.

## Boundary and provenance

- Integration worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`.
- Integration base: `860d89d49946e70541b1b13f2650e25d3edc15c7`.
- Source worktrees were tracked-clean at their recorded heads:
  - F21/F23 tuple source: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor` at `6f316fd305ea8eccaa27e8e029b171f3ad00d15f`.
  - F23 receipt-integrity source: `C:\Users\ThinkPad\.codex\worktrees\f23-receipt-integrity\Arbor` at `ec5afa5acd339354f7740564eec8d59e8b976467`.
- The target worktree was tracked-clean before integration. Its prior sole
  commit `0de7ea078486355cca8ca45e7c68521eb7f41970` was patch-id-equivalent to
  main commit `380a403408adec809f02481421d5e15023b92f63`; all other target
  commits were already in main history. It was safely detached at the stated
  base. `C:\Arbor` was not changed.
- Accepted proposal Git/LF blob SHA-256 values retained by this integration:
  F23 tuple ordering `51518D3B2F7BEFD453E8026189753F724EBADC88B2B4A33D067B5F41C7969F2D`;
  F21 v3 resource slice `274885C110E3B277753B49F6BAD023619ADFCF52D866CC86F01F27F7FDA85DD0`;
  F23 receipt integrity `70D55E2AD117D28522297B7BF55EC8AD479CA1BFEEF4025AEA7F1901793DD1A7`.

## Cherry-pick mapping

Mapped source commit prefixes below resolve uniquely in the recorded source
worktrees. The integrity series follows its actual parent DAG; `4520f48`
precedes `9a4ab67`.

| Source commit | Integrated commit | Subject |
|---|---|---|
| `28fa59d` | `7910ed8` | F23 tuple-ordering design landing |
| `ed1c9db` | `29c8f5c` | F23 tuple-before-decode implementation |
| `e31fdef` | `38bea25` | F21 v3 proposal revision |
| `a8d41c4` | `9ba4f4e` | F21 v3 proposal hash binding |
| `1526c30` | `eaac735` | F21 v3 owner-document landing |
| `d7dd300` | `873bb4f` | F21 UI contract clarification |
| `f9aad6f` | `28a9593` | F21 host Profile catalog |
| `cad8b9a` | `1178f3c` | F21 local-bind catalog guard |
| `0feb21b` | `b69f242` | F21 CreateProject v2 fixture migration |
| `c2f853d` | `e4e029d` | F21 CreateProject v2 trusted resource admission |
| `5b9ed0b` | `9e4796f` | F21 file-backed Profile fixture registration |
| `3dda164` | `f8331d6` | F21 canonical ownership seeds |
| `6f316fd` | `e009159` | F21 Web resource selection |
| `1b75bd3` | `63eda0e` | F23 receipt-integrity RED/proposal |
| `be5833b` | `b295b39` | F23 separate AH10 prior-consumer contract |
| `4520f48` | `edaa748` | F23 P9 disposition review evidence |
| `9a4ab67` | `2918146` | F23 P9 A1 disposition RED |
| `c1a7116` | `fe8d2b7` | F23 P9 RED assertion correction |
| `ac4a1ea` | `7152d73` | F23 owner-document landing, mechanically reconciled below |
| `eb2343c` | `67e90f5` | F23 source landing digest correction |
| `44074d8` | `5803f05` | F23 strict receipt decoders |
| `cfcdc3d` | `ae28fdb` | F23 inherited schema-key guard |
| `ec5afa5` | `fd4082f` | F23 trusted prior-receipt decoding and P9 route |

The side-branch proposal commits `b29b1a7` / `485bb62` were not added as
duplicate commits. Their proposal and decision-note Git blobs match the actual
F21 chain's `e31fdef` / `a8d41c4` blobs (including proposal blob
`9eef97e801891e222928f4230e09f387b45de444`, SHA-256 above); the final v3
proposal remains present and hash-bound.

## Integration reconciliation and decoder glue

The two accepted owner landings independently used DID v1.35 from v1.34. The
only content conflict was the DID dependency line: F21 had advanced System
Design to v1.13 while the F23 integrity branch was based on v1.12. The
integrated document retains both accepted amendment bodies without dropping
or overriding either contract, sets the unified DID to v1.36 (supersedes
v1.35, depends on SD v1.13), and labels the change as an integration
reconciliation. F21's closed Profile(ref,version) | ConversationOnly selector
and F23's authenticated/current-tuple-before-decode ordering remain
independent and compatible.

Original isolated landing digests are historical source-blob evidence and are
not the current integrated blob digests. Current Git-blob SHA-256 values for
owner files are:

| Owner file | Integrated SHA-256 | Source landing digest status |
|---|---|---|
| `docs/design/02-system-design.md` | `C2C9BBDCB072A58284472658ABB4D66E70268F95093D658158F87CBF635599C6` | unchanged from F21 landing |
| `docs/design/03-detailed-implementation-design.md` | `02D4A07AE202B5F5CD4597FFFC18C4CC0DBFCEBD7A1A9AA63B6336FBE83C27C2` | combined F21/F23 digest; prior v1.35 digests are historical |
| `docs/design/implementation/P1/01-command-contracts.md` | `CC2B9C20225E64520EE0AE649030D649761F6109188B054550D5CE9488970D7E` | combined F21/F23 digest; prior isolated digests are historical |
| `docs/design/implementation/P1/02-port-contracts.md` | `260BEE6DE87073D474F652D20680BD19BA13F6C63A2117266AD903E0E27B25DF` | combined F21/F23 digest; prior isolated digests are historical |
| `docs/design/implementation/P1/03-transaction-model.md` | `1B9571E8559486B4C38D5608D18C38A8390A04863402332C790D3E513751D366` | unchanged from corrected F23 landing |
| `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` | `3663BD8B0AACDDD505F5E8FE4DDC2BDCD131168D42D23A1CBC8C2811DD0B0804` | unchanged from corrected F23 landing |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `8B82994A19420CD821AA0B136569D00D151843657F6032B932A23D858A0396D1` | unchanged from corrected F23 landing |
| `docs/design/implementation/P12/00-contract-index.md` | `244C0B210D813A762401A873DFBEA4D08CD33DD217D8BDDDFE4FC721AE0B4870` | F21 landing with DID reference updated to v1.36 |
| `docs/design/implementation/P12/10-transport-shells.md` | `2B9E511C2D57E4B7F0573F1FDB2A2B6E6304BE5A7E9B6E043B04EA893C875535` | F21 landing digest is historical; current Authority reference is updated to integrated DID v1.36; the v1.34/v1.35 sequence in §9 remains historical |
| `docs/design/implementation/P13/02-command-exposure-matrix.md` | `C0544A12A7E55B209A2F427E4DD0E99EDE43455CB2FB81FD47BF84D9491EB688` | unchanged from F21 landing |
| `docs/design/implementation/MAC/03-golden-paths-and-fulfillment.md` | `BDCD4BEA0F0AECA967393A0BA350C908EB3FCF7EE1CAD60AC0424D7588E7C607` | unchanged from F21 landing |

F21 made CreateProject Handler schema v2 while retaining the existing result
DTO. F23 Wave1's source decoder supported only CreateProject v1 and did not
know the F21 rejection. This integration adds the exact same closed result
shape under current schema v2, removes the schema-v1 decoder (old v1 rows are
preserve-only and cannot be decoded as current), and adds the exact
`ProjectResourceUnavailable{commandId}` rejection validator. No profile ref,
path, filesystem detail, or extra field is accepted. The F23 tuple comparator,
transaction order, and other result/rejection validators are unchanged.

## Verification

- `pnpm build` — PASS.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check .` — PASS, 994 files; one pre-existing warning at
  `packages/agent-runtime/src/model-decision.ts:4070` (`noNonNullAssertion`).
  That file is byte-identical to the integration base. The changed decoder and
  codec test also pass a direct targeted Biome check.
- Decoder + P1/P12/F21/catalog targeted unit suites — 6 files, 35 tests PASS.
- F21 Profile daemon-restart public process test — 1/1 PASS.
- F21-specific Profile journey and forged-ref/path Playwright cases — 2/2 PASS.
- Generic ConversationOnly public conversation Playwright journey — 1/1 PASS.
- F23 Gateway tuple-ordering functional process tests — 2/2 PASS.
- F23 exact-tuple HTTP wrong-shape Committed receipt — 1/1 PASS.
- F23 direct-child P9 A1 malformed-result `corrupt-result-before` two-daemon
  process representative — 1/1 PASS (82.1s).
- Full `pnpm check`, full `pnpm test:functional`, and the full F23/P9 matrices
  were not run. They remain for post-review integration validation.

## Remaining boundaries

- FT-DG-01 OPEN-1 Profile-source audit, OPEN-2 historical CreateProject v1
  same-ID successful replay, and OPEN-3 post-commit durable Attention remain
  open.
- F23's P10 generic corruption Attention / operator-visible diagnostic sink
  and cross-schema prior-receipt replay compatibility remain open. No generic
  P10 source, SQL/DDL/migration, or EventVersion change was introduced.
- The integration has not been pushed or merged. Full suite validation is
  intentionally deferred until independent review.
