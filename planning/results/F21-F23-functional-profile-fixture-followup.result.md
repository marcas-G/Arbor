# F21/F23 Functional Profile Fixture Follow-up

## Scope

Test-only correction after the integrated full functional run at
`0fc59e51086ced7cd2ad725ee4b6f3542a538084`. No production, design, or Web
implementation was changed.

The first integrated run ended with Vitest 35 files / 152 tests: 32 files and
146 tests passed; 3 files and 6 tests failed. The three AH7 Reconcilable cases
and two AH15 Inbox promotion cases failed before their scenario assertions
because the crash-child daemon had an empty Project Resource catalog despite
`ARBOR_PROJECT_ROOT` being set. Inspection showed this test child calls
`main(config)` directly rather than the normal executable entrypoint, which
constructs `ProjectResourceProfilePort` from the environment.

The F23 `AcceptWorkOutcome` malformed `acp_` case timed out before issuing its
malformed command: its provider needed to inspect `proof.txt` and return
`FUNCTIONAL_VERIFIED`, but the project had the default `ConversationOnly`
boundary. The fixture now uses the governed host Profile selection for this
case only, allowing the intended normal verification precondition to complete.

## Changes

- `tests/functional/support/ah-crash-child.mjs` now constructs the same
  `ProjectResourceProfilePort` from `projectResourceProfilesFromEnvironment()`
  used by the production main entrypoint. It does not fabricate catalog data
  or weaken resource ceilings.
- `tests/functional/process/command-input-validation.functional.test.ts` opts
  only the `acp_` malformed-ID scenario into `admitWorkspaceDirectory` and
  public `resourceSelection: Profile`. The positive verification precondition
  and exact HTTP 400 `InvalidCommandPayload`, issue path, no-echo, no command /
  attempt / event / Acceptance, and unchanged Open Work assertions remain.

## Verification

- `pnpm build`: PASS.
- Targeted functional command over the three relevant files: 3 files / 8 tests
  PASS (F23 command validation 3/3, AH7 Reconcilable 3/3, AH15 Inbox promotion
  2/2).
- `pnpm typecheck`: PASS.
- Biome on both changed source files: PASS; `git diff --check`: PASS.
- The integrated full functional run before these test-only fixes remains
  **146/152 tests, 6 failed** as listed above. It was not rerun in this
  follow-up; this record does not claim a 152/152 integrated result. Vitest
  failure prevented the chained Playwright run in that batch.

## Remaining gate status

The sole full `pnpm check` at this integration HEAD passed before the
functional run. The full functional gate remains to be rerun after independent
review of these fixture corrections. No files outside the two tests and the
test-only crash-child helper were changed for this follow-up.
