# Sandbox Policy Candidate Read Model V5-A — Authorization and Integration

**Date:** 2026-10-19

**Implementation token:** `AUTHORIZE_SANDBOX_POLICY_CANDIDATE_READMODEL_V5_IMPLEMENTATION`.

**Fixed plan:** `planning/tasks/sandbox-policy-candidate-readmodel-v5-implementation-plan-v2.md`.

**Plan Git-blob raw SHA-256:** `B99C2682F30F277AA9E3C7C135E4A8A2C5C5811C3B44C380604ABB3B6F1CC3B9` (verified against both `c5050520` and the integrated `HEAD` blob). The Windows checkout uses CRLF and therefore has a different worktree-file byte hash.

**Owner gate:** V5 accepted proposal SHA-256 `26B4BDAA4F79DCF2A0EA7C601A1037372A9C5308AB761663A921235076CE8D13`; owner landing and independent post-landing review are recorded in `planning/results/sandbox-policy-candidate-readmodel-v5-acceptance.record.md` and `planning/results/native-os-sandbox-v21-producer-and-candidate-read-postlanding-review.result.md` (B0/B1/B2 = 0).

## Integrated scope

Starting from the unified candidate `8c45ee94`, the v1 and v2 planning commits `7ef83339` and `c5050520` and the isolated V5-A foundation `2a8fbcac` were cherry-picked. The only textual conflict was `packages/domain/src/index.ts`; the resolution exports both the current V3 boundary producer and the new V5 candidate codec.

V5-A adds the read-only P4 `SandboxPolicyRequirementReadPort` and its strict Pending-action/NotAdmitted-invocation/RecoveryBinding validation, a closed candidate DTO and `spc2_` identity codec, and additive Workspace Detail API/projection shapes. The candidate read and singular preconditions are mutually exclusive. This integration does not implement P5 snapshot, P4/P2 full-bundle currentness, P1/P13 selection, P10 production query/composition, production `sandboxProcessPolicy` injection, or two-daemon qualification. Those remain later slices in the fixed v2 plan.

## Focused verification

- `pnpm build`: PASS.
- `pnpm typecheck`: PASS.
- V5-A four focused Vitest files: 45/45 PASS (`packages/domain/test/sandbox-policy-candidate.test.ts`, `adapters/persistence-sqlite/test/sandbox-policy-requirement-read-port.test.ts`, `tests/p10-api-contracts.test.ts`, `tests/p10-views-detail.test.ts`).
- `pnpm lint` (Biome, 1,304 files): PASS; no fixes applied.
- `git diff --check`: PASS.

No schema, migration, database upgrade, new command/route, provider qualification, or release is authorized or claimed by this V5-A integration. No `docs/design/**` file was changed.
