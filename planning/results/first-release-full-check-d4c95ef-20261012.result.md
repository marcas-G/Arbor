# First Release Full Check — d4c95ef

Date: 2026-10-12 (Asia/Shanghai)

## Candidate and result

- Release worktree: `C:\Users\ThinkPad\.codex\worktrees\first-release-delivery\Arbor`.
- Exact code HEAD checked: `d4c95ef347dbb90b4d691b9a27f929444daadd30` (clean before the run).
- Command: one complete `pnpm check`, exit code 0, wall time 564.77 s.
- No functional or Playwright suite was run. Port `127.0.0.1:8787` remained on PID 8956 running this worktree's existing `apps/single-workspace/dist/main.js`; it was not stopped or otherwise controlled. No live/project database was opened or modified.
- The check regenerated `planning/results/P12.restore-drill.json`; after the run it was restored in this worktree to the candidate's original values and bytes, SHA-256 `350B05B358D6B188E7317AC4F14FBE74BD82FD7D79011B4BCE8EBBF5341BE919`.

## Final gate counts

| Stage | Result |
|---|---|
| Biome | PASS, 1,070 files checked, 0 errors and 1 existing `noNonNullAssertion` warning at `packages/agent-runtime/src/model-decision.ts:4070` |
| TypeScript build and test typing | PASS |
| Architecture Vitest | PASS, 31 files / 159 tests |
| Core Vitest | PASS, 356 files / 1,978 passed / 3 skipped (1,981 total), 456.36 s |
| Web typecheck | PASS |
| Web production build | PASS, 255 modules; existing >500 kB chunk advisory |
| Web Vitest | PASS, 33 files / 245 tests, 71.88 s |

The suite script did not invoke `pnpm test:functional`, Playwright, or a live daemon. These full local check results do not constitute a functional, S1–S4, or release-readiness claim.

## Four-run correction history

The successive exact-candidate runs establish this bounded cause-and-effect sequence; each run was executed once, without retry:

| Run / code HEAD | Outcome and blocker | Raw log SHA-256 |
|---|---|---|
| 01 — `dddfe048a892f2cdc952dc6d14ee0e6dcc539da7` | Stopped in Biome after checking 1,070 files: `apps/single-workspace/test/tool-authority-denial-production-pipeline.test.ts` had import organization and formatting errors (2 errors); plus the existing model-decision warning. Later stages did not run. | `B667229AAF5AE1F35362492BF9D5A67699CBCAF5E448ED8C9AC725C0D16E6B23` |
| 02 — `1a4df793a4a03beacecd949fbf9c4d5ce4980315` | The formatting/import fix made lint pass. TypeScript and Architecture passed; Core Vitest failed 4 cases in the P12 acceptance/transport tests because `arbor/ResourceOwnershipRepository` was absent. Core: 1,974 passed, 4 failed, 3 skipped. | `60486B1C56D785685DF0CE21692813455A2F775E270E1EF3FD8631479E1A1A73` |
| 03 — `b6565cd631b6f75f3e8a150a12cf57b82d62b97d` | The ownership-repository fixture fix made Core pass (1,978 passed, 3 skipped). Web typecheck/build passed, but `apps/web/test/issuer-restriction.test.tsx` failed: expected one request mock call, received zero because required target and expiration inputs were blank. | `091D1FE5DE890F99236CE14D94740E47D00CEB1793C032BA92223700972CDA87` |
| 04 — `d4c95ef347dbb90b4d691b9a27f929444daadd30` | The issuer fixture now supplies the required grant fields. Full `pnpm check` passed, including Web Vitest 33/33 files and 245/245 tests. | `DBDF182CB6D5E7BEB5E8081961B5F51EE154B29EC14AED39674E7A1E58D7AE16` |

All four raw logs are retained in the same release worktree at:

- `qualification-logs/01-check.log`
- `qualification-logs/02-check-1a4df793.log`
- `qualification-logs/03-check-b6565cd.log`
- `qualification-logs/04-check-d4c95ef.log`

The workspace is a local single-user baseline. Shell B1, VerifierOrphan governance, and P39 work were not merged into this candidate and are outside this check. Their status is not changed by a passing `pnpm check`.
