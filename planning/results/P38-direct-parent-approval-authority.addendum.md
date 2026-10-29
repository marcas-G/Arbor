# P38 direct-parent approval authority addendum

Date: 2026-10-16

Scope: route-specific `ResolveExecutableApproval` direct-parent authority
qualification. No production semantics or design files changed.

## Evidence

- The actual `AuthorityResolverPort` allows a non-human direct-parent principal
  only when `directParentOf` matches both the exact canonical approval
  `workspaceId` and parent principal. The returned
  `ExecutableApprovalDecisionAuthority` binds the canonical approval,
  workspace, execution, project, command, and expected revision.
- Resolver negatives reject a different parent, an edge to a foreign
  workspace, and absence of the direct-parent edge even when the input carries
  a revoked grant or an expired active grant. These grants do not substitute
  for the route's parent relationship.
- External command composition uses the actual resolver: exact-parent approval
  reaches the Gateway with the exact typed authority and returns the normal
  committed receipt projection. A wrong-parent request returns 403 without a
  Gateway call. Actor/principal spoof is rejected before the Gateway and does
  not create a receipt.
- The integration uses `makeExternalSubmission` rather than a live HTTP daemon;
  the existing P38 public-process suite separately covers public authorization
  denial/stale receipt behavior. No claim is made that the direct-parent case
  itself was exercised through a live public daemon.

## Verification

- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 packages/application/test/resolve-executable-approval-authority.test.ts apps/single-workspace/test/external-command-composition.test.ts` — **2 files / 13 tests passed**.
- `pnpm typecheck` — **PASS**.
- Biome on both changed test files — **PASS**.
- `git diff --check` — **PASS**.

No full functional or repository suite was run.
