# P37 Layered Delivery Qualification

Date: 2026-10-12
Baseline: `0580e454729da39e9ed7eec187938ce9528122fd`
Worktree: `C:\Users\ThinkPad\.codex\worktrees\delivery-layered-qualification\Arbor`
Status: **Layer 1 PASS; resumed L6 matrix 11/11 PASS; F19 public delivery/wake 2/2 PASS; broader release gates open**

## Baseline and owner

Qualification starts from the exact frozen integration commit above in a new,
detached worktree. The primary acceptance contract is P9's immutable
DeliverReplay fact/event and queue lifecycle, with P10 owning the safe
`ActionRequired` projection and marker-before-ACK behavior. The P37 L2/L3,
L5, and L6 checkpoint records are implementation/source checkpoints and are
not treated as qualification evidence for this baseline.

No `docs/design/**` or production source file was changed.

## Layer 1 — Migration, stores, Gateway, Attention

Environment setup:

- `pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1`
  — PASS, 8.4 s; reused 114 packages from the local pnpm store.
- `pnpm --filter @arbor/single-workspace... build` — PASS, 17.30 s.
- All Vitest invocations used `--maxWorkers=1 --no-file-parallelism`.

The final integrated command was:

```powershell
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --reporter=verbose `
  adapters/persistence-sqlite/test/p37-ah10-deliver-replay-migration.test.ts `
  adapters/persistence-sqlite/test/p37-attention-poll-store.test.ts `
  adapters/persistence-sqlite/test/p37-deliver-replay-outbox-store.test.ts `
  packages/application/test/p37-attention-poll-loop.test.ts `
  apps/single-workspace/test/deliver-replay-recovery.test.ts `
  tests/application/command-result-codec.test.ts `
  apps/single-workspace/test/external-command-codec-registry.test.ts `
  tests/p7-deliver-primitive.test.ts `
  tests/p7-deliver-control-route.test.ts `
  tests/p7-acceptance.test.ts
```

**PASS:** 10 files / 43 tests; Vitest duration 29.99 s; command wall time
32.14 s. Migration prefix upgrades v33–v37, SQLite outbox/marker ordering,
lease fencing, exact P9 event lookup, P10 Attention marker/ACK/offset/claim
order, DeliverMessage Gateway/codec, receipt recovery, and P7 delivery/wake
regressions all passed.

### Initial failures and test-fixture corrections

The first targeted invocation included three stale/nonexistent P7 paths under
`apps/single-workspace/test/`; Vitest silently ignored them. Its actual run was
7 files / 26 tests, with 22 passing and four failing in 37.19 s:

- Two `p37-attention-poll-loop.test.ts` cases failed with
  `ACK attempted before marker`. The mocked `projection.apply` recorded the
  event but did not model the P10 marker side effect. Production applies the
  Deliver event and persists its marker in the same projection transaction;
  the coordinator correctly skips the second marker write before ACK. The test
  fake now records that marker side effect.
- Two `external-command-codec-registry.test.ts` cases failed because the
  baseline includes the P38 `ResolveExecutableApproval` handler but its
  descriptor factory map/count expectations were still 27/26. The test now
  includes the command and expects 28/27.

The correctly located Gateway route test,
`tests/p7-deliver-control-route.test.ts`, initially failed with
`Deliver replay failure identity and store are required`. Its legacy fixture
omitted P37's required logical-action identity and replay-fact lookup. It now
supplies the deterministic identity and an empty replay-fact result, plus the
minimal no-prior-effects and receipt dependencies needed to reach Gateway.
That single test passed in 6.37 s, and the final 10-file integrated rerun above
passed.

The first CLI attempt also supplied unsupported Vitest 5 option
`--minWorkers=1`; argument parsing failed before tests ran (0.87 s). The
supported single-worker configuration is `--maxWorkers=1` together with
`--no-file-parallelism`.

Static verification for the three changed test files:

- Initial `pnpm exec biome check ...` — FAIL only on formatting in
  `tests/p7-deliver-control-route.test.ts` (1.29 s); formatted that file.
- Final `pnpm exec biome check packages/application/test/p37-attention-poll-loop.test.ts apps/single-workspace/test/external-command-codec-registry.test.ts tests/p7-deliver-control-route.test.ts` — PASS.
- `git diff --check` — PASS.

## Remaining layers

- L6 resumed process matrix evidence and F19 public journey evidence are
  recorded in `P37-L6-process-crash-matrix.result.md`.
- The L6 file is now under `tests/functional/process/`; Vitest's default
  process include selects its eight test definitions, including three
  parameterized definitions that expand to the unchanged 11 cases.
- Full `pnpm check`, full `pnpm test:functional`, and F20 clean-clone smoke:
  were not run in this staged pass and are not implied by the targeted passes.
