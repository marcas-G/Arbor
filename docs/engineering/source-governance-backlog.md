# R5 — Source-size governance backlog

Status: partial inventory and three completed structural slices; **not release qualified**.

Inventory base: `a468eddd439cf04a609c4e4b30f9e543084a9313`.
Implementation head before architecture/doc follow-up: `e3619eccb003a6e16db3bec5d8e34d55b9d09247`.
Policy: `scripts/governance/source-lines-lib.mjs` defines the source extension set and the 800-line maximum; do not exclude tests or adapters merely to pass the gate. The strict checkout scan is `pnpm check:source-lines` (or `node scripts/governance/check-source-lines.mjs`, no package install needed for that script). Transition mode with an explicit baseline is diagnostic and does not satisfy the final strict gate.

## Inventory scope and limitations

The complete recursive Git tree was fetched at the inventory base (not truncated): 4,182 entries, 1,563 paths matching the current source policy, including 704 under package/app/adapter src directories. 100 source blobs are at most 800 bytes and therefore cannot contain more than 800 lines under the current newline definition. The other files require content inspection. Byte size was used only to prioritize retrieval, never as a line-count result. The first 34 large production files and 16 large test files were fetched and individually counted; this is a partial inventory, not a complete list of violations. The counts are a snapshot of the inspected versions; subsequent changes must be rechecked on a checkout.

## Production priority queue

| Owner / source path | Inspected lines | R5 disposition |
|---|---:|---|
| adapters/persistence-sqlite/src/attention-projection.ts | 3048 | pending |
| apps/single-workspace/src/schema-upgrade.ts | 2975 | pending |
| adapters/persistence-sqlite/src/migrations.ts | 2654 | pending |
| apps/single-workspace/src/projection-query.ts | 2179 | pending |
| adapters/persistence-sqlite/src/ownership.ts | 1986 | pending |
| adapters/sandbox-native-posix/src/index.ts | 1778 | pending |
| packages/provider-runtime/src/runtime.ts | 1664 | decomposed |
| apps/single-workspace/src/composition.ts | 1595 | pending |
| packages/application/src/external-command-codec.ts | 1594 | decomposed |
| packages/projection-runtime/src/attention-loader.ts | 1575 | pending |
| adapters/persistence-sqlite/src/recovery-attention-fact-store.ts | 1553 | pending |
| packages/application/src/authority-resolver.ts | 1476 | pending |
| apps/single-workspace/src/production.ts | 1397 | pending |
| adapters/persistence-sqlite/src/work-readmission-gate.ts | 1368 | pending |
| apps/single-workspace/src/transport/composition.ts | 1325 | pending |
| packages/agent-runtime/src/agent-loop-driver.ts | 1319 | pending |
| packages/execution-runtime/src/execution-runtime.ts | 1296 | pending |
| adapters/persistence-sqlite/src/tool-invocations.ts | 1200 | pending |
| packages/execution-runtime/src/recovery.ts | 1177 | pending |
| apps/single-workspace/src/p6-inbox-rebuild.ts | 1166 | pending |
| packages/application/src/verification-signal-reconciliation.ts | 1154 | pending |
| packages/application/src/workflow-signal-consumer.ts | 1135 | pending |
| apps/single-workspace/src/sandbox-policy-decision-preparation.ts | 1126 | pending |
| apps/single-workspace/src/executable-tool-handler.ts | 1126 | pending |
| packages/ports/src/provider.ts | 1121 | decomposed |
| adapters/sandbox-windows/src/native/WindowsSandboxBridgeHarness.cs | 1050 | pending |
| adapters/persistence-sqlite/src/session-repository.ts | 1034 | pending |
| apps/single-workspace/src/schema-upgrade-manifest.ts | 1000 | pending |
| adapters/persistence-sqlite/src/executable-approval.ts | 964 | pending |
| adapters/persistence-sqlite/src/recovery-binding-store.ts | 915 | pending |
| apps/single-workspace/src/main.ts | 899 | pending |
| adapters/persistence-sqlite/src/sandbox-provider-unavailable.ts | 873 | pending |
| packages/application/src/commands/conclude-verification.ts | 848 | pending |
| adapters/persistence-sqlite/src/sandbox-policy-requirement-read-port.ts | 819 | pending |

## Test priority queue

| Test path | Inspected lines |
|---|---:|
| tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts | 8588 |
| packages/tool-runtime/test/p4-pipeline.test.ts | 5314 |
| tests/p9-acceptance.test.ts | 4210 |
| tests/p3-driver.test.ts | 4003 |
| tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts | 3938 |
| tests/functional/process/sandbox-policy-v6-registry-drift-restart.functional.test.ts | 3230 |
| tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts | 3219 |
| tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts | 2773 |
| tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts | 2765 |
| tests/p12-acceptance.test.ts | 2751 |
| tests/p10-acceptance.test.ts | 2746 |
| tests/functional/process/p38-executable-approval-public.functional.test.ts | 2652 |
| apps/single-workspace/test/ah10-generation-command-takeover.test.ts | 2336 |
| tests/functional/process/ah18-overflow-linked-compaction-resume.functional.test.ts | 2203 |
| tests/capability/real-provider/public-s4-recovery.test.ts | 2102 |
| tests/p7-acceptance.test.ts | 2090 |

## Implemented slices

| Commit | Owner | Conservative split-line count before → after |
|---|---|---:|
| a78ab74c5496e6c87adcbd8b87217b27764a954a | external-command-codec.ts | 1595 → 376 |
| 4a2e3ab82cd7fd0a229c893262887662cbef5b15 | provider-runtime/runtime.ts | 1665 → 752 |
| e3619eccb003a6e16db3bec5d8e34d55b9d09247 | ports/provider.ts | 1122 → 15 |

The command codec separates public contracts, declarative payload rules, rule constructors and generic decoding. The provider runtime separates streaming, continuation evidence, failures/configuration and recovery discovery. Native-success recovery updates the invocation-owned cancellation state at the original boundaries, before and after the existing atomic settlement. Provider ports separate the portable request, protocol, turn store, model-context and secret contracts behind the existing barrel. There are 17 files across these three module groups, all below the cap in the conservative split-line count; no package dependency changed.

Static checks: 5/5 per slice (15/15 total); exact generic decoder, payload rules, rule constructor, stream consumer and provider contract bodies were compared to the base (allowing required export modifiers). Provider runtime selected durable/transport operation literal call counts match, including 20 transact, 5 settleAttempt, 6 settleTurn and 2 settleSuccessAtomically. All seven original qualification boundary names remain present. Provider contract 96 named declaration exports and 10 service tags match the original. All 39 existing architecture files were scanned for literal references to moved source locations; P12 secret-redaction ownership assertion follows the actual implementation and retains a facade re-export check. New R5 ownership assertions forbid private implementation references back to the facade or package barrel. Static inspection does not prove type compatibility, transaction equivalence, or full test behavior.

## Next execution order

1. Agent-loop-driver, execution-runtime/recovery and remaining provider/runtime formatting headroom; verify runtime cancellation, recovery and authority handoffs.
2. SQLite persistence and schema upgrade: extract statement/query families and migration ranges without changing migration ordering, digest/manifest identity, or transaction semantics.
3. Application/projection/transport composition: preserve read-versus-mutation ownership and public contracts.
4. Large test suites: split by independently named scenario family; preserve fixture ownership, test names, qualification coverage, suite manifests and test discovery.
5. Complete a strict whole-tree line scan, then pinned formatting, compilation, architecture, core and functional gates. Do not promote before qualification.

## Qualification limitations

The local checkout is unavailable (fresh git ls-remote fails github.com DNS resolution; Node v22.16.0 vs pinned v24.21.0 and pnpm absent). The existing CI workflow triggers PR, merge group, default-branch push, or manual dispatch; the governance branch has no workflow runs in the checked listing. No PR was opened or mainline merge performed. Do not treat the partial inventory or the 15 static checks as executed Vitest or full qualification. Existing CI and self-hosted runner authorization are unchanged. The strict source-lines gate remains required before final promotion; complete inventory and actual test qualification are still blockers.
