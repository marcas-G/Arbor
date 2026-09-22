# P12 — 04 Observability / Health / Usage Plane (G4)

**Authority:** DID v1.14 G4, §7.2 (Port Catalog — observability ports register under this
catalog as a P12 addition), §10.4.1 (package DAG), §10.5 (Problem DTO); SD v1.3 §10.2
(Durable Event Journal → Telemetry channel), §10.7 (Durability Envelope), §7.7
(Resource control 与 Usage), §14 No.45; P2 `04` §3.1/§3.2 (`provider_turns.usage_json`
/ `provider_attempts`); P3 `01`
§3–§5 (`UsageReported` / Turn-vs-Attempt); P4 (`tool_invocations`); P9 `03` §2 (T1
recovery); P10 `01` §1 + `05` §1 (Usage view / `UsageReq`, observe-only).
**Status:** DRAFT.

## 1. Boundary (frozen)

Metrics / logs / traces / health projections are **derived operational state**.

```text
derived operational state  ≠  canonical state
```

They **MUST NOT** become authoritative substitutes for canonical `Execution`,
`ProviderTurn`, `ToolInvocation`, `Command`, or `DomainEventJournal` facts. Where an
operational value conflicts with a canonical fact, the canonical fact wins.

## 2. Observability surface

```text
Metrics  : counters/gauges derived from canonical records + runtime events
Logs     : structured, correlation-id tagged; non-canonical channel (SD §10.2 Telemetry)
Traces   : provider turn / tool invocation / command spans
Health   : liveness (process) + readiness (DB open + migration baseline + T1 recovery done)
```

- The telemetry channel is explicitly **excluded** from the durable journal and authority.
- No telemetry value may be read back to make an authority/scheduling decision.
- **Module / package (E-16).** The operational observability plane is the `observability`
  module: `packages/projection-runtime/src/observability/**` (derived read models; DID
  §10.4.1 allows `projection-runtime → domain, ports`). Ports (`HealthPort`) are declared
  in `packages/ports` under the DID §7.2 catalog (P12 addition). No separate physical
  package is created — consistent with G8's no-empty-shell-package rule and the frozen
  §10.4.1 matrix (no new edge).

### 2.1 P12 contract revision — `HealthPort` added to the frozen DID §7.2 catalog

The frozen DID §7.2 Port Catalog (Runtime / External capability) does **not** list a
health port. P12 records an **explicit contract revision**:

```text
DID §7.2 Port Catalog (Runtime / External capability)
  + HealthPort                          (P12 contract revision)
```

- This is a **catalog addition only**: it adds `HealthPort` to the DID §7.2 catalog; it
  changes no existing port's semantics and no top-level DID semantics.
- No new physical package and no new dependency edge (DID §10.4.1 unchanged; G8's
  no-empty-shell-package rule).
- `HealthPort` is declared in `packages/ports` (DID §7.2 catalog) and implemented by the
  `observability` module (E-16). This document is the phase-scoped authority recording the
  addition; the DID catalog itself is amended only by manual governance.

## 3. Usage (frozen derivation)

### 3.1 Canonical source (DF-08 reconciliation)

Usage is derived from real facts, with exactly one authoritative source per output:

| Output | Authoritative source |
|---|---|
| token amounts (input / output / cache) | `provider_turns.usage_json` (P3 `04` §3.1; `UsageReported` aggregates per Turn = sum over attempts, P3 `01` §5) |
| turns | `provider_turns` rows |
| attempts / retries | `provider_attempts` rows (P3 `04` §3.2 — **no usage columns**) |
| tool usage / outcome | `tool_invocations` (P4) |
| compute time | `executions.admitted_at` / `settled_at` deltas |
| pricing | versioned price sheet (operational config, **not** canonical state) |

- `provider_turns.usage_json` is **authoritative for token amounts**; `provider_attempts`
  is **authoritative for attempt-level transport facts only** (count / outcome /
  `provider_error_kind` / timing) and **MUST NOT** supply token amounts (it has none).
- Both P10's Usage view and P12's derivation read the same canonical tables; neither
  duplicates authority (see §5).

### 3.2 `UsageCost` ADT (E-15)

```ts
type UsageCost =
  | { readonly _tag: "Known"; readonly amount: number; readonly currency: string;
      readonly priceSheetVersion: string }
  | { readonly _tag: "Unknown"; readonly reason: UsageUnknownReason }

type UsageUnknownReason =
  | "PricingUnavailable"   // no versioned price sheet present
  | "UsageUnavailable"     // no usage facts present
  | "PartialUsage"         // some contributing turns lack usage
```

- `Known` requires **both** non-empty usage facts **and** a versioned price sheet
  (`priceSheetVersion` non-empty). Absent pricing → `Unknown("PricingUnavailable")`.
- **unknown cost must remain `Unknown`, never `0`**: no path may construct
  `Known { amount: 0 }` when pricing is absent or usage is missing.

### 3.3 `UsageService.derive` (E-15)

```ts
interface UsageService {
  derive(facts: UsageFacts): UsageDerivation   // pure: R = never, deterministic
}

type UsageFacts = {
  readonly turns: ReadonlyArray<{ readonly providerTurnId: string;
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number;
      readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number } }>
  readonly attempts: ReadonlyArray<{ readonly providerTurnId: string;
    readonly attemptNo: number; readonly outcome: string }>
  readonly toolInvocations: ReadonlyArray<{ readonly invocationId: string;
    readonly outcome: string }>
  readonly executions: ReadonlyArray<{ readonly executionId: string;
    readonly admittedAt: string; readonly settledAt?: string }>
  readonly priceSheet?: { readonly version: string; readonly currency: string;
    readonly unitPrices: Readonly<Record<string, number>> }
}

type UsageDerivation = {
  readonly cost: UsageCost
  readonly tokens: { readonly input: number; readonly output: number;
    readonly cacheRead: number; readonly cacheWrite: number }
  readonly turns: number
  readonly attempts: number
  readonly computeMs: number
}
```

- `derive` is a pure function of its declared `facts` (`R = never`): no ambient I/O.
- `cost` is `Known` iff every contributing turn has usage **and** `priceSheet` is present;
  otherwise `Unknown` with the matching reason.
- Aggregation scopes Workspace / subtree / Project (SD §7.7) are computed by grouping the
  same derivation; **observe-only** by default (invariant 45). No auto stop from user cost
  budget.

### 3.4 E-15 assertions

```text
derive(attemptWithoutPricingVersion).cost._tag === "Unknown"
no path constructs Known { amount: 0 } when pricing is absent
turns without usage → cost Unknown("UsageUnavailable") (never Known { amount: 0 })
Known.amount derives only from provider_turns.usage_json × versioned price sheet
```

## 4. Health / readiness (E-17)

```ts
type ReadinessState = {
  readonly dbOpen: boolean
  readonly migrationBaseline: boolean
  readonly t1RecoveryComplete: boolean
}

interface PersistenceHealthProbe {
  // Narrow read-only capability (DID §7.2): reports the current readiness
  // dimensions. E = never — a health probe reports false dimensions, it does
  // not fail. Never a telemetry service; never mutates canonical state.
  probe: () => Effect.Effect<ReadinessState, never>
}

interface HealthPortService {
  liveness(): Effect.Effect<{ readonly processAlive: true }, never>
  readiness(): Effect.Effect<ReadinessState, never, PersistenceHealthProbe>
}
```

- `readiness()` derives its state **exclusively** from the injected
  `PersistenceHealthProbe.probe()`; `PersistenceHealthProbe` is the only capability in its
  `R` channel. No telemetry / observability service is reachable from `readiness()`.

Readiness rule (frozen):

```text
ready ⇔ dbOpen ∧ migrationBaseline ∧ t1RecoveryComplete
```

- `dbOpen`: canonical DB connection is open (reopen/`integrity_check` path available).
- `migrationBaseline`: `PRAGMA user_version` equals the P12 migration baseline
  `max(P12_MIGRATIONS) = 13` (P1 `06` §5; `00` TR-7).
- `t1RecoveryComplete`: the startup recovery pass (SD §10.6 steps 1–6; P9 `03` §2 T1) has
  completed. **Readiness is true only after T1 recovery completes.**
- Health is read-only derived state; it never mutates canonical state and is never an
  authority input. `PersistenceHealthProbe` is a narrow read-only capability — never a
  telemetry service.

### 4.1 E-17 assertions (three readiness transitions)

```text
Transition 1 (db):        probe() dbOpen false → true
  while dbOpen = false                                 → readiness() = false
Transition 2 (migration): probe() migrationBaseline false → true
  while migrationBaseline = false                      → readiness() = false
Transition 3 (recovery):  probe() t1RecoveryComplete false → true
  while t1RecoveryComplete = false                     → readiness() = false
readiness() = dbOpen ∧ migrationBaseline ∧ t1RecoveryComplete (true iff all three true)
readiness() flips false → true only when the last missing dimension
  (t1RecoveryComplete) transitions to true after the T1 recovery pass completes
readiness() reads only PersistenceHealthProbe.probe(); no other capability in R
```

## 5. Ownership split with the P10 Usage view (DF-08)

```text
P10 owns : UI-facing Usage view + query (UsageReq, P10 `05` §1; observe-only,
           invariant 45) and its view semantics / materialization / rebuild
           (P10 `04` §2).
P12 owns : operational derivation / aggregation (UsageService.derive), the
           UsageCost ADT, pricing versioning, aggregation scopes, and the
           canonical-source mapping (§3.1).
```

- P12 **MUST NOT** reinterpret P10 view semantics (transport renders only, `10`); P10
  **MUST NOT** redefine derivation / cost semantics.
- `UsageReq` renders aggregate token / turn / cost rows sourced from
  `provider_turns.usage_json`; its `cost` field is the P12 `UsageCost` ADT
  (`Unknown` preserved, never `0`).

## 6. Module placement + architecture test (E-16)

- Observability module: `packages/projection-runtime/src/observability/**` (module
  `observability`); `HealthPort` declared in `packages/ports` (DID §7.2). No new physical
  package (G8; §10.4.1 DAG unchanged).
- Architecture test `tests/architecture/p12-observability-boundaries.test.ts` asserts:

```text
packages/execution-runtime/src/scheduler.ts does not import the observability
  module (or projection-runtime)
packages/tool-runtime/src/admission.ts does not import the observability module
  (or projection-runtime)
the R channels of scheduler decide() and tool admission contain no telemetry /
  observability service (no TelemetryService / ObservabilityService /
  UsageService / HealthPort)
```

## 7. Invariants

```text
CI-3  no operational (metrics/log/health/usage) value is treated as authoritative
      - no scheduler/admission/authority decision reads telemetry
      - no usage value substitutes for a canonical record
unknown cost ≠ 0
pricing versioned
readiness = dbOpen ∧ migrationBaseline ∧ t1RecoveryComplete
```

## 8. Must Not Decide

- No new canonical tables for telemetry; no telemetry in the domain event journal.
- No usage-based automatic mutation (Safety Envelope is separate, `08`).
- No reinterpretation of P10 view semantics (transport renders, `10`).
- No telemetry / observability service in scheduler or tool-admission R channels.

## 9. Verification

```text
unknown cost → Unknown (never 0); derive(attemptWithoutPricingVersion).cost._tag === "Unknown"
usage derives from provider_turns.usage_json (tokens) + provider_attempts (attempt facts)
  + tool_invocations + executions only
health readiness = DB open + migration baseline + T1 recovery complete
  readiness false when DB closed / migrations behind; true only after T1 recovery
no scheduler/admission code path imports the observability module or telemetry service
```
