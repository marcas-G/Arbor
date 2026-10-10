# F23 Legacy Fixture Migration — App and P12 Tests

Date: 2026-10-10
Baseline: `e372f8dd4e377654ab43a9bbf3f9f9bd6455bd47`
Accepted contract: `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`
Accepted EGP contract: `ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE`

## Result

**The scoped legacy fixture migration is complete and the 21 targeted files
pass.** The fixtures now use the current strict command descriptors and exact
execution episode/result forms; test intent and assertions are retained.

The existing app-level `admitExecution` helper had a real stale writer defect:
it included both legacy `focus` and the exact Work `episode`. That minimal
production fix was committed separately as `4eb28f7` with its own RED/GREEN
record. The fixture tests that call the helper pass after that fix. The direct
Gateway test fixtures in the Wave 2/P5 tests now omit the superseded `focus`
property while retaining their exact WorkEpisode and revision.

P12 remote-worker fixtures now pair a `DecisionEpisode` binding with the
matching `DecisionSubmitted` settlement result. The P12 acceptance
`CreateProject` external envelope uses the same Actor as its authenticated
`HUMAN` Principal. The P14 conversation fixture now uses valid UUIDv7 IDs for
its seeded HumanMessage, command and prior ProviderTurn references; its
conversation/tool-history assertions are unchanged.

The `focus` field still present in the P5 slice test output is only a
test-local result label for its scheduler decision assertion; it is not an
AdmitExecution payload or a new-write compatibility path.

## Verification

- Initial targeted run before fixture convergence reproduced the failures as
  `InternalCommandContractDefect` for `AdmitExecution` (`focus` unknown field)
  and `SettleExecution` (superseded result enum), plus the P12 external
  `CreateProject` failure from Actor/Principal mismatch.
- `pnpm build` — PASS before the targeted fixture run.
- Targeted Vitest run for all 15 `tests/p12-*.test.ts` files and the six named
  app tests — **PASS, 21 files / 172 passed / 2 skipped / 0 failed**.
- `pnpm typecheck` — PASS.
- Biome check on the 21 targeted test files — PASS.
- No full `pnpm check` or `pnpm test:functional` was run.
- No `docs/design/**` file or `tests/capability/black-box/s1-s4-public-api.test.ts`
  file was changed.

## Scope

This commit contains only test fixtures and this result record. The helper
production fix remains isolated in `4eb28f7`; no Gateway validation or test
assertion was bypassed, weakened, or skipped.
