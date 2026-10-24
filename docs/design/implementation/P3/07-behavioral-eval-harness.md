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

### Accepted S4-CONTEXT-DG-01 projection eval obligations (2026-10-24)

The deterministic/model-light P3 eval and integration coverage for accepted
same-Session AssistantMessage projection must exercise these contracts and
record the exact program/manifest hashes:

- valid exact ProviderTurn/contentRef/source/content-hash binding yields one
  assistant-role DataOnly C3 item in sequence order; missing, malformed,
  mismatched, or unsupported legacy binding yields no inferred message and
  follows the typed integrity boundary;
- output append changes the next newly prepared same-Session portable request
  and request hash; the actual SessionRepository-selected frontier is covered,
  not only a hand-built projector input;
- the pre-checkpoint latest-64 selection does not refill filtered rows, and
  post-checkpoint projection uses the exact checkpoint and unsummarized typed
  frontier; Summary coverage claims only content actually represented;
- ToolCall/ToolResult/ControlResult chronology and projection remain intact;
- text-only WorkspaceWork `Stop` with no ToolInvocation remains nonterminal
  when the existing same-Execution loop continues, and the next request sees
  that exact accepted output without treating text as canonical progress or
  completion;
- pinned ProviderTurn replay does not duplicate the accepted Session append or
  recompile an already prepared Manifest; ConversationResponse remains isolated
  to its P14/P17 RootWorkspaceId-owned history/checkpoint.

These obligations do not change the eval harness's fake/recorded-provider
determinism contract or authorize live Provider evaluation. They do not change
`RuntimeSafetyObservation` generation, P12 D2/D4 update rules, `MAX_TURNS`,
settlement, or stop/fencing policy; P12-DG-01 remains a separate owner question.

## 6. Must Not Decide

- No program text for feature-phase-owned families.
- No acceptance criteria for other phases.
- No live-provider determinism guarantee.
- No replacement of the domain/invariant test suites.
