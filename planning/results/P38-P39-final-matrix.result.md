# P38/P39 final receipt and freshness matrix

Status: **PASS for the reviewed P38/P39 matrix rows; broader P38 closure remains open.**

- Baseline: `ea25e282`.
- Scope: P39 persisted environment revision matching, invocation-vs-boundary
  revision refresh, Workspace snapshot drift at the bounded final claim check,
  target-region digest vectors, and real-daemon P38 approval receipt projection
  into RecoveryBinding V1. No production semantics or frozen design files
  changed.

## P39 ToolRuntime freshness

- `EnvironmentRevisionStore.current() = Some(E_invocation)` succeeds only when
  both invocation and Workspace-boundary environment resolutions equal that
  exact current revision.
- When `E_invocation != E_boundary`, P4 refreshes once; a refreshed matching
  pair then reaches one ResourceAdmission, one exact approval consumption,
  one P39 claim binding and one effect admission.
- After that refresh is spent, both Workspace resource-boundary revision drift
  and address drift at the final claim validation fail closed. The approved
  claim transaction rolls back before ToolInvocation intent, approval consume,
  RecoveryBinding, attempt-0, ResourceAdmission or effect admission. The
  approval remains Approved and no Denied terminal row is synthesized.
- The `None` / observed `"0"` case remains a success; other `None` revisions
  fail stale. The target digest is asserted against the resolver's selected
  region subset, not the broader Workspace boundary.
- Fixed region identity vectors cover empty, single, multiple, reversed order,
  duplicate multiplicity and the FileTree/GitWorktree canonical alias. Digest
  input preserves P4 resolver emission order and multiplicity; it applies no
  P39 sorting or deduplication.

## Real P38 receipt-to-RecoveryBinding projection

The public-process precommit and postcommit claim/restart cases now inspect the
actual consumed approval row and actual P39 canonical RecoveryBinding. They
assert `approvalSubject`, exact `approvalExpiresAt`, `approvalTargetDigest`
derived from the persisted target resource IDs, and exact
`approvalActionDigest`, as well as approval/Execution/Step/ToolInvocation IDs,
pre/post-consume revisions, consumedBy, canonical binding hash, row hash
agreement and attempt-0 binding hash. The precommit case confirms the old
claim rolls back before takeover; the postcommit case confirms the committed
binding is reused after restart. Neither path constructs a fixture binding in
place of Runtime mapping.

The test-only lease qualification was made deterministic under the two-daemon
precommit race by stopping both old and competing owners before the exact
observed-generation expiry CAS, then starting the recovery owner. The owner is
confirmed dead before expiry; no lease timeout or wait bound was relaxed.

## Verification

- P39 target:
  `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 packages/tool-runtime/test/p4-pipeline.test.ts -t "P39"`
  — **9 passed, 29 skipped**.
- Real P38 process claims:
  `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "rolls back a same-Step P38/P4/P39 claim killed inside its transaction|reuses a committed same-Step approval claim after a process crash before effect admission"`
  — **2 passed, 9 skipped**.
- `pnpm typecheck` — **PASS**.
- Biome on both changed TypeScript files — **PASS**.
- `git diff --check` — **PASS**.

No full functional or repository suite was run. This result closes only the
reviewed P38/P39 matrix rows and does not claim formal P38 closure.
