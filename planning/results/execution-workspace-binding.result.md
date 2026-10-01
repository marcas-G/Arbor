# Execution Workspace Binding / DOGFOOD-DG-03 Result

**Date:** 2026-10-02

**Status:** COMPLETE — DESIGN RESOLVED / IMPLEMENTATION PROVEN / LIVE DOGFOOD PASS

**Implementation revision:** `f9c00cd`

## Outcome

Arbor no longer asks a model-facing filesystem tool to reuse a host
`ResourceAddress` as a sandbox-relative path. Every new filesystem invocation
uses a logical target:

```text
{ mount: "workspace", path: "relative/path" }
```

Tool Runtime selects the unique primary filesystem address from the current
Workspace ResourceBoundary, resolves/adopts its canonical region, performs
authority + ownership admission, and opens that resource as the process-local
`workspace` mount. Host paths never become model-supplied authority facts.

## Landed contracts

- DID v1.25 EWB-1…EWB-10
- `docs/design/implementation/P4/04-sandbox.md`
- `docs/design/implementation/P4/08-minimal-tools.md`
- `docs/design/implementation/P11/12-sandbox-handoff.md`
- accepted decision:
  `planning/proposals/tool-resource-sandbox-target-v2-governance-decision.md`

## Implementation evidence

### Tool and sandbox surface

- `read/list/patch/shell@2` expose mount-relative schemas and hashes.
- `ExecutableToolHandler` resolves the exact visible catalog version instead of
  hard-coding v1.
- `SandboxPort` carries mount bindings/opened mounts.
- trusted-local adapter binds the admitted managed worktree directly and never
  deletes it on close.
- target validation rejects absolute/drive/UNC/backslash/control/empty/`..`
  paths and checks realpath/junction/symlink confinement.
- `patch@2` creates a missing file from a pure insertion, accepts a standard
  trailing newline and preserves idempotent replay.
- builtin filesystem path/IO failures become `ExpectedFailure`; executor
  defects remain visible to P9 recovery.

### Runtime convergence defects found by dogfood and repaired

1. A stopped/crashed prior Execution left one unresolved ToolCall in the shared
   Session. A subsequent execution now appends an idempotent sourced
   `Interrupted` ToolResult before inference.
2. A fixed recent-entry limit could start at ToolResult and omit its ToolCall.
   `listRecentEntries` now computes the iterative minimal causal closure; a
   regression test proves a two-step backward expansion.
3. FileTree/GitWorktree aliases resolve to one canonical region. Boundary
   activation now emits one claim per canonical region instead of requiring
   address/region arity equality.
4. Concurrent HTTP/daemon transactions previously issued overlapping
   `BEGIN IMMEDIATE` statements on one connection. `TransactionPortLive` now
   serializes independent transactions with a one-permit semaphore while still
   rejecting true nested transactions. A concurrency regression test proves
   both writes commit.
5. External CreateProject/CreateChildWorkspace post-commit convergence now
   activates missing ownership claims. Successful SteerWork clears a prior
   WorkWait so human intervention actually wakes the Work.

## Live qualification

Project/workspace/work:

```text
Project:   prj_01a0f82d-f3f5-7d2a-a2c8-d4770c25d496 (发布候选验证)
Workspace: ws_01a0f82d-f59c-7550-a2cb-316212c4f397
Work:      wrk_01a0f834-681f-7b62-9455-aa83bba1e10b
Worktree:  C:/Users/ThinkPad/.codex/worktrees/release-dogfood/Arbor
```

The Arbor Agent, not the human/main agent, created:

```text
tests/architecture/p17-conversation-runtime.test.ts
```

It independently performed:

```text
pnpm install --frozen-lockfile                     PASS
npx vitest run tests/architecture/p17-conversation-runtime.test.ts
                                                    1 file / 3 tests PASS
mutation probe containing includeTools              expected FAIL
probe removal + focused rerun                        3/3 PASS
biome format/check                                   PASS
git diff --check                                    PASS
pnpm build                                          PASS
pnpm architecture                                   21 files / 124 tests PASS
```

Final canonical settlement:

```text
Execution: exe_886068a0-850b-7174-89ec-163bc7b1aa34
Settlement: Completed(CompletionClaimed)
Work revision: 1
Claim: clm_1ab275af-4c0d-7511-8c98-eb00ede04d1a
```

Isolated worktree scope at qualification end:

```text
 A tests/architecture/p17-conversation-runtime.test.ts
107 insertions, 0 deletions
```

No push occurred; `C:/Arbor`, `.env` and `arbor.config.json` were outside the
Work's mutation/read scope.

## Repository verification

Main implementation verification after all runtime changes:

```text
pnpm lint          PASS
pnpm typecheck     PASS
architecture       121 / 121 PASS
core tests         1529 PASS / 1 SKIP
web typecheck      PASS
web build          PASS
web tests          212 / 212 PASS
git diff --check   PASS
```

## Verdict

`DOGFOOD-DG-03` is RESOLVED. The mount-relative tool contract, authority and
ownership path, real Worktree execution, causal Session recovery, concurrent
transaction safety and CompletionClaim delivery are mechanically demonstrated.
