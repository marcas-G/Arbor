# P38 Layered Executable Approval Qualification

**Status:** Public process and Browser Queue layers PASS (5/5) on the v5
candidate. This is scoped release qualification evidence; it does not claim
full P38 closure.

## Baseline and source ownership

- Candidate baseline: `e1f07b37291b9521cc5dffdf708a65da0efd7816`
- Test/promotion commit: `ec79ad0` (`test(p38): promote qualified approvals to default suites`)
- Worktree: `C:\Users\ThinkPad\.codex\worktrees\approval-layered-qualification-v5\Arbor`
- No production source or `docs/design/**` files were changed in the test
  qualification commit.
- Approval contracts remain owned by P4 `03` (exact intent, consumption, and
  side-effect admission), P12 `02` (trusted approval production), and P10 `02`
  (safe Inbox/Attention projections).

The v5 candidate includes the Control AssignWork CommandId transaction fix,
local-only trusted human bootstrap, no-auth non-loopback bind guard, and P37
receipt repair. All journeys here used the test fixture's localhost-only daemon.

## Setup

```text
pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1
  PASS — 7.0 s; 114 packages reused from local store
pnpm --filter @arbor/single-workspace... build
  PASS — single-workspace dependency DAG
pnpm --filter @arbor/web build
  PASS — 255 modules; existing >500 kB chunk warning
```

The two promoted files passed targeted Biome and `git diff --check`. The full
`pnpm check` and full `pnpm test:functional` were not run.

## Public process layer

The public API tests were moved from `tests/functional/pending/` into the
default `tests/functional/process/` tree, and their `it.skip` markers were
removed. The default `vitest.functional.config.ts` discovers this path without
configuration changes. Runs used one worker, no file parallelism, zero retries,
and selected only this file.

```powershell
pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose tests/functional/process/p38-executable-approval-public.functional.test.ts
```

**PASS — 1 file / 4 tests, 70.10 s total.** Per-case Vitest durations:

| Journey | Result | Case time | Assertions established |
|---|---:|---:|---|
| Approve | PASS | 17.270 s | Same Execution, AgentLoopStep, logical action, and ToolInvocation resume; approval is Consumed, effect succeeds exactly once. |
| Reject | PASS | 12.713 s | Same pending action reaches `TerminalRejected`; invocation is Denied; no shell effect. |
| Expire | PASS | 14.553 s | TTL expiration reaches the typed denial path; same action is `TerminalRejected`; no shell effect. |
| Two-daemon restart | PASS | 24.655 s | Restart and a peer daemon converge on the same approval/action/ToolInvocation; one successful effect and no daemon errors. |

The test helper now asserts the exact branch outcome: Consumed →
`Applied`/`Success`/one effect; Rejected or Expired →
`TerminalRejected`/`Denied`/zero effects. This corrects the former assertion
that incorrectly required `Applied` after a no-effect rejection.

## Browser Queue layer

The browser test moved into the default `tests/functional/ui/` tree and its
`test.skip` marker was removed. The default Playwright config already discovers
that directory; no config changes were needed.

```powershell
pnpm exec playwright test --config playwright.functional.config.ts --workers=1 --retries=0 --reporter=list tests/functional/ui/p38-executable-approval-browser.spec.ts
```

**PASS — 1 test, 26.4 s test time / 29.8 s command time.** The human approved
the exact Executable approval from Queue; the original action resumed and its
effect occurred once. A unique shell canary remained absent from the Inbox
target DTO, validated arguments preview, and approval details DOM. The details
rendered the expected tool version, Execution, digest, capability, and
side-effect semantics.

There was a short, unplanned overlap between this Playwright run and a P37 L6
process started by another agent. The browser test passed without retries;
record this scheduling overlap as a qualification caveat.

## Default-suite promotion

- Public API journey: `tests/functional/process/p38-executable-approval-public.functional.test.ts`
- Browser Queue journey: `tests/functional/ui/p38-executable-approval-browser.spec.ts`
- No duplicate public/browser P38 files remain under `tests/functional/pending/`.
- `vitest.functional.config.ts` and `playwright.functional.config.ts` were
  unchanged.
- The separate in-memory SQLite store case remains under `pending/`; the
  previously supplied candidate evidence for SQLite/P2/P10/Web focused suites
  is not repeated or enlarged by this 5/5 qualification.

## Limits

This result covers the four public process cases and one browser Queue case on
the v5 local candidate. It is not a claim that all P38 requirements, migration
compatibility, full release gates, or P37 L6 are complete. The five tests were
run individually first under the pending configs, then the four public cases
and browser case were rerun under their default discovery configs; the
per-case and aggregate durations above refer to the default-config runs.
