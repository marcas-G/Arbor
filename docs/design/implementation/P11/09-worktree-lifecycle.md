# P11 — 09 Worktree Lifecycle (GQ1a)

**Authority:** GQ1(a) 裁决; DID §1.4A (RetireWorkspace preconditions), ResourceAddress.GitWorktree; SD §11.3 (two modes as configuration); P4 `08` (lifecycle deferred to P11).
**Status:** DRAFT.

## 1. Command family (existing vocabulary; no new subsystem)

```text
CreateWorktree  { projectId, workspaceId, worktreeId, address: GitWorktree{path, repositoryRef, branch} }
RetireWorktree  { worktreeId, expectedState }
```

States: `Active → Retired` (terminal). Events: `WorktreeCreated`, `WorktreeRetired`.

## 2. Payload completion (UD-1 closure)

`GitWorktree = { path, repositoryRef?, branch? }` (additive domain payload; aliases normalize per C8 at resolve time).

## 3. Terminal paths & ownership closure (CI-3)

- `RetireWorktree` precondition: no **active ownership claims** resolved into the worktree's regions; otherwise typed rejection (operator must release first via `10` paths).
- `RetireWorkspace` interaction: the frozen §1.4A precondition (no active claims) is **enforced, not bypassed** — retirement is refused while claims are active (typed rejection pointing at the release paths); once clean, worktree-cleanup surfaces as a governance suggestion (deletion is a manual/ops act — files are never auto-deleted).
- Worktree lifecycle stays consistent with ownership lifecycle: claims record `resolvedAtEnvironmentRevision`; a WorktreeLifecycle cause RecordEnvironmentChange (when worktree add/remove changes the resolved region set) follows `03` CAS.

## 4. Modes are configuration

Shared Repository / Isolated Worktree (SD §11.3) are deployment/configuration semantics — no state machine; isolated-mode materialization (region→root at sandbox open) lives in `12`.

## (mapping: CI-3)
