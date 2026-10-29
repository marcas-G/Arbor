# SCRC-008 — Recovery, Qualification, Migration Proof and Closure

## Source

- P9 `04` §5 / `07` AH15–AH19; P12 qualification; SCRC acceptance matrix T01–T30

## Depends On

- SCRC-002
- SCRC-003
- SCRC-004
- SCRC-005
- SCRC-006
- SCRC-007

## Objective

Finish cross-boundary crash recovery and provider qualification, prove migration
0019/restart/dogfood continuity, run the full regression gate, and write the
SCRC implementation result record. This task alone may mark implementation
complete after every prior task passes.

## Outputs

- AH15–AH19 two-sided fault-injection suite;
- v18→v19 migration/re-entry/legacy fixtures;
- compatible-provider end-to-end continuity scenario;
- architecture/negative-scope guards;
- `planning/results/SCRC.result.md` with T01–T30 evidence.

## Must Hold

- no duplicate input/effect/request/checkpoint across crash/restart;
- no secret/context authority leak;
- G-V2-1…4 untouched and still scoped;
- historical tests/closures remain green;
- production data is not mutated outside tested migration/runtime paths.

## Must Not Decide

- No additional feature, UI work, provider family, gap closure or result claim without evidence.

## Acceptance

- T01–T30 all mapped to green evidence; AH15–AH19 pass both sides; `pnpm check`
  green; result record complete; zero open SCRC Design Gap.

## Verification

```bash
pnpm test scrc-recovery-qualification
pnpm test scrc-acceptance
pnpm architecture
pnpm check
```
