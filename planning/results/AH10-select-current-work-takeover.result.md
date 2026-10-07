# AH10 SelectCurrentWork cross-generation takeover — qualification result

Date: 2026-10-07

Status: **RED / setup qualifies a genuine Scheduler DecisionEpisode, but the
new daemon did not acquire its expired lease; no FencingRejected receipt or
takeover assertion was reached. Do not count this as AH10 PASS.**

Test: `tests/functional/pending/ah10-select-current-work-takeover.functional.test.ts`

## Public setup and durable precondition

The test uses the production daemon, public `CreateProject`, `GrantPermission`
and `AssignWork` commands, and model-facing `assign_work` / `wait` controls.
Two runnable alternatives are assigned while the initial Work Episode is
active; that Work then records a `Manual` wait. The real Scheduler persists
one Pending `WorkSelectionDecisionRequest` with the exact two candidate Work
IDs and admits a `DecisionEpisode` at request revision 0. The provider returns
`select_current_work` for one of those candidates. The existing child-only
`AH10_GATE_ACTION_KIND` probe pauses at that action's committed intent.

The failure snapshot contained exactly the expected two Workspace executions:
the settled waiting Work Episode and the target DecisionEpisode. The target
DecisionRequest remained Pending/revision 0, the target action remained
Pending with no Observation, and `workspace.current_work_id` remained the
waiting Work. There was no SelectCurrentWork Command receipt. No InboxEpisode
or other execution had acquired a lease.

## Failure boundary

After observing the target gen0 lease expire under the real 30-second TTL, the
test started a second production daemon against the same DB. During its
45-second bounded wait, the child emitted no `AH10AfterLeaseAcquired` event for
the target or another execution. The final read-only snapshot showed target
lease generation 0 still expired, no gen1 lease, no old or new Command, and no
Workspace/DecisionRequest mutation. The old Work Episode lease was also expired
and had already received its `SettleExecution` Command; its durable Manual wait
remained registered.

Thus this run never reached the old-owner FencingRejected boundary. The
observable gap is that an expired active `DecisionEpisode` was not redispatched
by the second daemon in this setup. Treat this as a potential recovery/dispatch
implementation or design gap and review the owning frozen recovery/episode
contracts before changing product code. No production code or frozen design
was changed and no semantic resolution is proposed here.

## Validation

Independent revalidation on 2026-10-07:

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-select-current-work-takeover.functional.test.ts -t before
1 failed / 1 skipped; test 82.54s (Vitest total 83.46s)
Failure: gen1 did not acquire DecisionEpisode lease. No FencingRejected receipt,
new Command, or selection mutation was observed. The after-commit variant is
skipped because the same takeover precondition has not been met.

pnpm lint          PASS (Biome 944 files)
pnpm typecheck     PASS
pnpm architecture PASS (30 files / 155 tests)
pnpm check         PASS (core 315 files / 1708 passed + 3 skipped;
                    Web 31 files / 216 tests; typecheck/build PASS)
```

The default `vitest.config.ts` excludes `tests/functional/**`; the isolated
pending red therefore does not enter `pnpm check` or `pnpm test:functional`.
The earlier concurrent SendMessage type diagnostic in this file's history is
superseded by the current successful typecheck; it was not a current failure.
