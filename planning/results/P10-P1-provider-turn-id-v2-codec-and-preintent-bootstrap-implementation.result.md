# P10 → P1 ProviderTurnId V2 Codec and Pre-Intent Bootstrap — Implementation Result

Date: 2026-10-21

Status: **IMPLEMENTED; targeted qualification passed. Independent code review
is pending.**

## Authorization and fixed sources

Implementation used the accepted ProviderTurnId V2 contract
`ACCEPT_P10_P1_PROVIDER_TURN_ID_CODEC_V1` (proposal SHA-256
`5794DD19BA3BF1BDF58C0878863F1F51EA154CBF541E893CFA1CC63758108D2E`), the
reviewed plan SHA-256
`ADD4F83D1B2F48CAFCB0A98DFB50D48F9099E1332736B62F38E3F8129A821EA2`, and the
separately active bootstrap and ProviderTurnId V2 implementation
authorizations recorded by the coordinating root. No `docs/design/**` file was
changed.

## Implementation

The Domain now decodes exactly the seven frozen deterministic V2 families and
the historical UUIDv7 read/replay form. Typed constructors validate exact
UUIDv7 ExecutionIds and canonical safe ordinals for inference, repair,
Summary/Native compaction, Conversation Summary/Native checkpoint compaction,
and ordinal-zero OverflowReplacement. The constructor path cannot emit a
UUIDv7 ProviderTurnId. Malformed IDs, unknown suffixes, leading-zero ordinals,
unsafe numbers and non-zero overflow ordinals fail decoding.

Agent Runtime producers now use the typed constructors. Session source
qualification decodes the ProviderTurnId portion before accepting only the
documented source suffixes (`:assistant` or one non-empty call reference).
Persisted ProviderTurn, AgentLoopStep, P20 link, conversation checkpoint,
AssignWork binding, submitted-decision and legacy-adoption reads now validate
ProviderTurnIds and fail closed on malformed rows. Provider stores preserve the
exact decoded spelling. SQLite schema, migrations, P1 payload/fingerprint and
result shapes, receipt bytes, public stream fields and P9 terminal behavior are
unchanged.

The public P38 qualification fixture conditionally uses the test-only V2
authority source, authenticated human governance composition, and a real
GitWorktree. It grants the exact P1 capability while the Execution is active,
then pauses the shell Provider response. While the exact Executable approval is
Pending, the test reads the public Workspace Detail CandidateRead and verifies
the same public approval/action state, no ToolInvocation, no RecoveryBinding
and zero effects before P1. P1 commits from the public CandidateRead; the same
CAPA approval is then resolved, and P4 resumes the original Step/action. The
restart qualification kills the process after the P1 commit and before the
human approval. The P39 claim qualification kills inside the claim transaction
and proves recovery admits one effect.

## Commits

- `70e0b63e` — closed Domain codec and constructors.
- `ca160161` — Agent Runtime producer conversion.
- `8d2fbf73` — strict SQLite ProviderTurnId row decoding.
- `a555b753` — exact ProviderTurnId decoding for Session source references.
- `fb6a6c65` — public P38 pre-intent CandidateRead/P1/approval qualification.
- `b9fa0d0d` — import organization after the complete Biome scan.

## Verification

- Domain ProviderTurnId codec matrix: **13/13 passed**.
- Current ProviderTurnId, persistence, P1 CandidateRead/CAS, command/result,
  legacy adoption-store tests: **128/128 passed** in the final targeted batch.
- P3 driver, P20 overflow/replay, AgentLoopStep recovery/resume and compaction
  tests: **76/76 passed**.
- P9 provider disconnect/recovery selected targets: **3/3 passed**.
- P17/P14 public conversation progress and stream bridge tests: **14/14
  passed**.
- P38 approve, reject, expire, two-daemon restart and P39 precommit claim
  process cases: **5/5 passed**. The separate approve case was rerun after
  adding the explicit read-only CandidateRead oracle: **1/1 passed**.
- V6 post-intent registry-drift/restart public process qualification:
  **1/1 passed**.
- AH18 linked overflow process suite: **11/12 passed** on the full run. In the
  `manifest-context-epoch` case, the expected fail-closed diagnostic was not
  present in the captured child output (only the Node bootstrap stack was
  available), and Windows cleanup reported `taskkill` exit 255 after the helper
  had already exited. The same isolated corruption/recovery case then passed
  **1/1**; the full-run cause remains unconfirmed.
  The other 11 full-suite cases passed, including both overflow-link commit
  sides, both Summary-turn commit sides, terminal `failTurn`, orphan-manifest
  rejection, and second-ContextLimit terminalization.
- `pnpm lint`: **PASS**, Biome checked 1,348 files.
- `pnpm typecheck`: **PASS**.
- `pnpm architecture`: **PASS**, 37 files / 194 tests.
- `git diff --check`: **PASS**.

The full `pnpm check` sequence and full `pnpm test:functional` release batch
were not run. The coordinating root requested integration/review before those
broader gates; individual lint, typecheck and architecture gates were run.

## Scope and limits

There is no DDL, migration, backfill, ID aliasing, historical byte rewrite,
provider support claim, P1 fingerprint/result-schema change, or P9
terminal/no-later-action change. UUIDv7 values remain read/replay-only. This
result does not close unrelated AH7/AH10/AH14 gaps or make a full release
readiness claim.

Independent implementation review: pending.
