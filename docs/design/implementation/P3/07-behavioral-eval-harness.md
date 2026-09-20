# P3 — 07 Behavioral Eval Harness

**Authority:** DID v1.7 §0.3, §8.19, §13; C3/C5.
**Status:** DRAFT (first draft for contract review).

## 1. Purpose

Prompt/Context changes are behavior code (DID §0.3): they must be versioned,
provenanced and regression-tested. P3 establishes the **shared harness**; each
phase owns its own Prompt Program text, eval cases and acceptance criteria.

```text
P3 owns:  the harness contract + execution mechanics
phase owns: program text, eval cases, acceptance thresholds
```

## 2. Harness contract

```ts
interface BehavioralEvalHarnessService {
  readonly run: (suite: EvalSuiteRef) => Effect.Effect<EvalReport, EvalHarnessError>;
}

interface EvalSuiteRef {
  readonly suiteId: string;
  readonly programRefs: ReadonlyArray<{ programId: string; revision: number; hash: string }>;
  readonly caseRefs: ReadonlyArray<string>;
  readonly acceptance: AcceptanceCriteria;
}

interface EvalReport {
  readonly suiteId: string;
  readonly results: ReadonlyArray<EvalCaseResult>;
  readonly passed: boolean;
  readonly manifestHashes: ReadonlyArray<string>;
}
```

- The harness records the exact program revisions/hashes and the
  `ModelContextManifest` hashes it exercised, so a regression is reproducible.
- The harness is deterministic given a fixed fake/recorded provider (`§4`).

## 3. Per-phase ownership

| Concern | Owner |
|---|---|
| Harness contract + runner + reporting | **P3** |
| Base Agent / Responsibility-bound / Work Execution / Compaction Program text + eval cases | **P3** |
| Responsibility Formation / Bootstrap / Handoff programs | P6 |
| Communication / Coordination programs | P6/P7 |
| Verification program + evidence acceptance | P8 |
| Query / Human Steer programs | later phase |
| Acceptance thresholds for a phase's programs | that phase |

Each phase's Prompt Program change is gated by its own suite; a phase may not
change another phase's program or thresholds.

## 4. Determinism

- Eval runs use a **fake/recorded provider** implementing `ProviderPort` with
  fixed `CanonicalProviderEvent` sequences; no live network in CI.
- Numeric thresholds are empirical and live in the suite's acceptance criteria,
  not in the contract.
- The harness may be run against a live provider for dogfooding, but contract
  acceptance uses the deterministic path.

## 5. Regression gating

```text
prompt/context contract change -> new revision/hash + eval run
wording-only change            -> eval run (no revision) if it changes hashes
numeric default change         -> eval run; acceptance may be re-tuned
```

A failing suite blocks the change; the harness reports which program revision
and manifest hash regressed.

## 6. Must Not Decide

- No program text for feature-phase-owned families.
- No acceptance criteria for other phases.
- No live-provider determinism guarantee.
- No replacement of the domain/invariant test suites.
