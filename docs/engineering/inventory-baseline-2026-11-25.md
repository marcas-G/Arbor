# Repository inventory baseline

Snapshot of Git tree f564f6e1a19d737a4a5ef71d8858efa6481cfeb8, commit 29f95b9605307c6be391d2f2bcf8c99521321880, before this inventory change. Complete remote tree (not truncated), 3834 tracked blobs. Classification is preliminary and path-based, not a determination of semantic authority or whether each individual historical document is obsolete.

| Asset kind | Files |
|---|---:|
| current-status | 4 |
| decision-record | 14 |
| documentation | 15 |
| engineering-governance | 6 |
| engineering-tool | 36 |
| normative-design | 145 |
| other | 204 |
| planning-review-required | 921 |
| production-source | 637 |
| proposal-or-gap | 232 |
| test | 794 |
| verification-evidence | 826 |

## Workspace modules

- `adapters/blob-local`: 4 tracked files
- `adapters/environment-local`: 4 tracked files
- `adapters/environment-resolver-local`: 3 tracked files
- `adapters/persistence-sqlite`: 193 tracked files
- `adapters/provider-fake`: 3 tracked files
- `adapters/provider-openai`: 7 tracked files
- `adapters/provider-testecho`: 3 tracked files
- `adapters/sandbox-local`: 8 tracked files
- `adapters/sandbox-native-posix`: 5 tracked files
- `adapters/sandbox-windows`: 21 tracked files
- `adapters/sandbox-worktree`: 3 tracked files
- `adapters/secret-env`: 3 tracked files
- `adapters/secret-file`: 3 tracked files
- `adapters/worker-local`: 3 tracked files
- `adapters/worker-transport`: 3 tracked files
- `apps/single-workspace`: 177 tracked files
- `apps/web`: 263 tracked files
- `packages/agent-runtime`: 92 tracked files
- `packages/api-contracts`: 6 tracked files
- `packages/application`: 112 tracked files
- `packages/domain`: 74 tracked files
- `packages/execution-runtime`: 20 tracked files
- `packages/model-context`: 36 tracked files
- `packages/ports`: 77 tracked files
- `packages/projection-runtime`: 27 tracked files
- `packages/provider-runtime`: 5 tracked files
- `packages/testkit`: 7 tracked files
- `packages/tool-runtime`: 45 tracked files

11 packages, 15 adapters, 2 apps. All 11 core production dependency manifests inspected remotely; declared internal runtime dependencies match the existing package DAG (testkit treated separately). Actual source import graph is not yet verified; the diagnostic below is for that next check.

## Priority findings

- 1,933 files under planning, including 803 results and 570 testing files. Retain them; classify individual lifecycle and references before moving.
- CURRENT_STATE links to a missing recovery report. Confirmed correct target is planning/results/design-merge-regression-recovery-20261109.result.md: its date, versions, and scope match. Corrected only this path in the same change.
- CURRENT_STATE still identifies a worktree containing uncommitted changes. Do not replace this evidence identity with the current commit without re-verification.
- Largest production hotspots (bytes from exact Git tree):

- `packages/agent-runtime/src/model-decision.ts`: 292,100 bytes
- `packages/tool-runtime/src/runtime.ts`: 206,291 bytes
- `apps/single-workspace/src/control-actions.ts`: 191,807 bytes
- `adapters/persistence-sqlite/src/attention-projection.ts`: 137,731 bytes
- `adapters/persistence-sqlite/src/migrations.ts`: 111,758 bytes
- `apps/single-workspace/src/schema-upgrade.ts`: 106,907 bytes
- `packages/agent-runtime/src/agent-loop-actions.ts`: 97,085 bytes
- `apps/single-workspace/src/projection-query.ts`: 84,915 bytes
- `adapters/persistence-sqlite/src/ownership.ts`: 84,179 bytes
- `adapters/sandbox-native-posix/src/index.ts`: 65,862 bytes

## Reproduce and extend

Run from a clean checkout, writing output outside the repository:

```sh
node scripts/governance/inventory.mjs > /tmp/arbor-inventory.json
node scripts/governance/audit-imports.mjs > /tmp/arbor-imports.json
node --test scripts/governance/inventory-lib.test.mjs
```

The inventory enumerates tracked files and exact root-relative inline-code references in tracked Markdown, not every possible link or anchor. The source audit uses existing @babel/parser to extract literal imports/exports and compare actual edges with manifest declarations; it is diagnostic and does not replace the existing package DAG, enforce semantic ownership, or claim complete alias resolution. Findings are review items, not automatic permission to modify code. Errors or changing checkout identity are reported explicitly. Dirty snapshots are not qualification evidence. Output is generated on demand, not checked in as thousands of redundant file records.

Remote static review is not a local full-repository run. No frozen design, business logic, CI enforcement, or historical evidence is changed by this increment. Next: run both tools in the actual pinned environment; classify findings and prioritize one behavior-preserving module seam with explicit tests.
