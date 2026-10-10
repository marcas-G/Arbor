# F23 AH7 multi-action public Work seed

## Scope and baseline

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

Baseline: `756784bb3f524a250b25ec5ceabc3c578e25283a`, detached and clean after
confirming the AH9/AH11 source commits were patch-equivalent in the shared
branch. Only these files changed:

- `tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-two-action-interleaving.functional.test.ts`
- this result record

No production code, `docs/design/**`, shared `production-fixture.ts`, or
unrelated test was changed.

## Change

Each test replaces direct external `/commands` `AssignWork` with the public
process path: human `SubmitHumanMessage` → Root Agent `assign_work` → exact
Governance Inbox approval → public `ResolveControlApproval(Approve)` → Open
`current-work`. Each fixture preserves the exact `fs:write` WorkspaceAgent
grant required by the patch actions.

The ordinary daemon lets the new Work enter a legal Manual wait. The tests
confirm public Work revision 0 and idle state, capture the seed Execution IDs,
and verify no seed Execution is Failed. Only then do they kill the ordinary
daemon, restart with the requested AH7 crash probe, and public `SteerWork` at
revision 0 to start the measured Work turn. Every probed Execution is asserted
absent from the seed set. Seed Root and Manual-wait turns do not return a P4
patch call; measured target provider calls and actions remain separately
counted.

The B-effect case preserves A Applied / cursor 1 before restart, then proves
B's Idempotent effect occurred while B remained Pending and unsettled. Recovery
settles that same invocation once, advances the cursor to 2, and preserves one
ToolResult, Artifact and Observation for each A/B call, with both file contents
and invocation identities checked. The original persisted ProviderTurn is
required to contain one model output and exactly two `patch` callRefs; the B
effect probe's callRef must be the B call from that same ProviderTurn.

The B-intent case preserves A Applied / cursor 1, then proves B's P4 intent is
durable before the file effect: B remains Pending with no Observation, no B
ToolResult/Artifact and no B file. Recovery reuses the pinned ProviderTurn,
decoded output and B invocation, applies B once, and checks unique action,
ToolInvocation, ToolResult, Artifact and Observation identities. The original
ProviderTurn is checked for one persisted model output with exactly A/B's two
callRefs.

The two-action interleaving case preserves the initial cursor-0 / no-effect
crash, resumes A's result under the same ProviderTurn at cursor 1, then recovers
B to cursor 2. The persisted ProviderTurn is checked to contain exactly the
original A/B callRefs. Per-execution snapshots retain exact Action,
ToolInvocation, ToolResult, Artifact and file-effect uniqueness checks.

The tests no longer count every `role: tool` message as a P4 result: the legal
seed Manual wait is also represented as a tool message in Provider context.
Instead they scope P4 ledger assertions by the measured Execution/source refs
and preserve provider-decision limits plus exact persisted ProviderTurn
callRefs. This does not raise the original provider-call cap or suppress a
failed target action.

## RED / verification

- After `pnpm exec tsc -b --force` rebuilt the isolated TypeScript outputs,
  each original test independently reproduced HTTP 403
  `authority/denied` / `UnsupportedOrigin:AssignWork` at its public-client
  setup: B-effect 1/1 RED, B-intent 1/1 RED, and two-action interleaving 1/1
  RED.
- Revised individual focused runs passed: B-effect 1/1, B-intent 1/1, and
  two-action interleaving 1/1.
- Final combined focused run: 3 files / 3 tests PASS (212.50s).
- `pnpm typecheck`: PASS.
- Biome on all three changed tests: PASS.
- `git diff --check`: PASS.
- Full `pnpm check` and `pnpm test:functional` were not run.

No design gap was found. This evidence is limited to the three focused AH7
multi-action crash journeys and does not claim broader AH7/F23 closure.
