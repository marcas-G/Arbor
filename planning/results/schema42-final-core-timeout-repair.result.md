# Schema-42 final core timeout repair

Date: 2026-10-14

Status: **TARGETED CORE QUALIFICATION PASS**

The second full-check run left nine core timeout/cleanup failures (excluding
the CLI operator suite). This test-only repair raises the affected current
composition and integration case bounds to 120 seconds, gives their cleanup
hooks explicit bounds, and gives the P40 suite template setup a 300-second
bound. Assertions and production code are unchanged.

P40 now uses the existing real schema-42 suite-template factory and a separate
case clone. The other listed schema-42 suites already build one real P39
template in `beforeAll` and clone it per case. The helper does not provide a
cross-file template: Vitest isolates suite lifecycles, so sharing across files
would require a separate global lifecycle change; no such change was made.

P5 slice acceptance also registers its host Project Profile scratch directory
for after-each removal with bounded retries. P13 keeps its suite-owned daemon
and fixture lifecycle, with explicit 120-second bounds on the production API,
responsibility-tree, WebSocket cases and suite cleanup. P14 scratch cleanup now
uses bounded retries as well.

## Verification

- P5 (`p5-directive-unsupported`, `p5-session-continuity`,
  `p5-slice-acceptance`): **3 files / 3 tests PASS**, one worker, 103.61 s.
- P40 and MAC-P1/P2 (`p40-p9-p10-production-recovery`,
  `mac-p1-workspace-knowledge`, `mac-p2-parent-accept-result`,
  `mac-p2-workspace-placement`): **4 files / 4 tests PASS**, one worker,
  125.03 s.
- P13/P14 (`p13-web-e2e`, `p14-conversation-history-pagination`,
  `p14-real-provider-conversation`): **3 files / 9 tests PASS**, one worker,
  123.02 s.
- Biome on all 10 changed test files: **PASS**.
- `pnpm typecheck`: **PASS**.
- `git diff --check`: **PASS**.

The qualification is focused on the nine reported core timeout/cleanup
failures. It is not a rerun of the full repository check.
