# P12 — 14 Acceptance / Exit Criteria

**Authority:** DID v1.14 §11 P12, G1–G8, phase state; P12 completion blockers; P12 contract set `01`–`10`, `12`, `13`; P11 `00` (acceptance/closure pattern), P11 `06`/`13`; `planning/results/P8.result.md` (consumer-loop daemon wiring).
**Status:** DRAFT.

## 1. Acceptance story (deterministic)

One end-to-end story proving the production/extensibility plane (doc set `01`–`10`, `12`, `13`):

```text
1.  plugin registered (PluginId/PluginVersion/PluginSdkApiVersion) + Project tool
    explicit registration (content/version-bound)                     -> `01`
2.  unregistered project tool not visible/invocable                   -> `01`
3.  Authority Resolver produces trusted fact for a governance command
    (External Stop path) without mutating canonical state             -> `02`
4.  SecretStorePort resolves a SecretRef; no material in any durable
    or observable surface                                             -> `03`
5.  observable usage derived from real facts; unknown cost = Unknown  -> `04`
6.  StorageScaleAssessment yields a verdict; DurabilityEnvelope declared
    + restore drill executed                                          -> `05`
7.  remote worker submits a fenced ExecutionOrigin mutation; control plane
    commits it in one transaction; no worker DB access                -> `06`
8.  ToolCatalogPort resolves model-facing ToolDefinition; compiled request
    carries real description/schema/version                           -> `07`
9.  each §8.16A dimension D1–D6 drives a violation → Interrupted(RuntimeSafetyStop),
    Work Open; reset on the stated trigger                            -> `08`
10. region encoding convergence: resolver output matches frozen object
    encoding; narrow invalidation reachable                           -> `09`
11. transport renders api-contracts DTOs; forwards a Command; no direct
    canonical write; recovery/consumer daemons wired; Search recorded as
    an out-of-v1 deferral (P10-owned, unfrozen semantics; transport
    mechanism only)                                                    -> `10`
12. real provider adapter + model catalog + ModelCapabilityPort replace the
    fakes; a non-read/patch/shell tool runs the unchanged P4 pipeline  -> `12`
13. Information Trust Plane tags DataOnly fragments and canRaiseAuthority is
    enforced at the context boundary; operating envelope measured     -> `13`
```

## 2. Exit criteria

1. `pnpm check` green (lint + typecheck + architecture + test).
2. Plugin SDK/SPI + compatibility policy + Project-tool registration/trust implemented (`01`).
3. Authority Resolver production plane implemented; produces exact-bound facts; no mutation/approval/tool (`02`).
4. `SecretStorePort` / `SecretRef` + real adapter; no-leak invariant holds (`03`).
5. Observability/health/usage plane implemented; derived-only; unknown cost ≠ 0; pricing versioned (`04`).
6. `StorageScaleAssessment` + `DurabilityEnvelope` / backup / RPO-RTO / restore drill (`05`).
7. Remote Worker transport/identity boundary; single-writer preserved; no direct DB (`06`).
8. `ToolCatalogPort` model-facing resolution; no placeholders (`07`).
9. §8.16A D1–D6 complete with all eight evidence facets (`08`).
10. Region-encoding convergence; narrow invalidation reachable (`09`).
11. Transport shells bind `api-contracts`; no view-semantics reinterpretation; recovery/consumer daemons wired; Search remains a P10-owned out-of-v1 deferral (no Search surface; transport binding only if/when P10 freezes a Search view contract) (`10`).
12. Real provider adapter + model catalog + `ModelCapabilityPort` implementation; non-minimal tools via `ToolDefinition` + `ToolExecutor` seam, P4 pipeline unchanged (`12`).
13. Security hardening enforced (Information Trust Plane, sandbox trajectory) + declared operating envelope with measurement method (`13`).
14. All P12 completion blockers mechanically evidenced; no open P12 Design Gap.

## 3. Test-ID mapping (E-21)

Each exit criterion and each completion blocker maps to a test file + test name.
Mechanical evidence only; mirrors the P11 `p11-acceptance` / `p11-closure` pattern.

### 3.1 Exit criteria → tests

| EC | Criterion | Test file | Test name |
|---|---|---|---|
| EC-1 | `pnpm check` green | repo gate | `pnpm check` (lint + typecheck + architecture + test) |
| EC-2 | Plugin SDK/SPI + registration/trust (`01`) | `tests/p12-plugin-sdk.test.ts` | "compat MAJOR mismatch → PluginCompatibilityError; project tool requires explicit registration" |
| EC-3 | Authority Resolver production plane (`02`) | `tests/p12-authority-resolver.test.ts` | "resolver produces exact-bound facts; no CommandGateway/mutation/approval/tool path" |
| EC-4 | SecretStorePort / SecretRef + adapter (`03`) | `tests/p12-secret-store.test.ts` | "resolve typed failures (missing/inaccessible/expired); no SecretMaterial leak" |
| EC-5 | Observability/health/usage (`04`) | `tests/p12-observability.test.ts` | "derived-only; unknown cost ≠ 0; pricing versioned" |
| EC-6 | StorageScaleAssessment + DurabilityEnvelope + snapshot pruning/retention (`05`) | `tests/p12-storage.test.ts` | "checked-in artifact verdict ∈ {SQLiteSufficient, PostgreSQLRequired}; measurements cover every declared envelope dimension; `assessStorage(envelope,[])` → `InsufficientEvidence` (negative test only); restore drill evidence; RPO/RTO declared; snapshot pruning: pruned-but-referenced refused (typed), unreferenced pruned, canonical records untouched" |
| EC-7 | Remote Worker transport/identity (`06`) | `tests/p12-remote-worker.test.ts` | "mediated mutation = fence+mutate+resolve+event one tx; no worker DB; stale incarnation rejected" |
| EC-8 | ToolCatalogPort model-facing (`07`) | `tests/p12-toolcatalog.test.ts` | "real description/schema/version resolved; no placeholder in compiled request" |
| EC-9 | §8.16A D1–D6 (`08`) | `tests/p12-runtime-safety.test.ts` | "each dimension drives Interrupted(RuntimeSafetyStop), Work Open; reset on trigger" |
| EC-10 | Region-encoding convergence (`09`) | `tests/p12-region-encoding.test.ts` | "resolver emits frozen object encoding; narrow invalidation reachable without re-wrapping" |
| EC-11 | Transport shells (`10`) | `tests/p12-transport.test.ts` | "renders api-contracts DTOs; forwards Command; no canonical write; daemons wired; Search deferral recorded (no query semantics invented)" |
| EC-12 | Real providers/tools (`12`) | `tests/p12-providers-tools.test.ts` | "real adapter + catalog + capability replace fakes; non-minimal tool through unchanged P4 pipeline" |
| EC-13 | Security/performance (`13`) | `tests/p12-security-performance.test.ts` | "DataOnly enforced via canRaiseAuthority; sandbox guarantees; envelope measured" |
| EC-14 | Blockers evidenced; no open Design Gap | `tests/architecture/p12-closure.test.ts` | "every P12 blocker mapped; no open planning/gaps/P12-*.md" |

### 3.1A Architecture suites (F10)

These architecture tests are part of EC-1 (`pnpm check`) and the closure gate:

| Target | Test file | Assertion |
|---|---|---|
| allow-list reconciliation (G8/DF-16, `01`) | `tests/architecture/package-dag.test.ts` | no `verification-runtime` entry; `environment-resolver-local` / `sandbox-worktree` edges reconcile to `domain, ports` only (DID §10.4.1) |
| observability boundaries (`04`) | `tests/architecture/p12-observability-boundaries.test.ts` | no scheduler / tool-admission import of the observability module; scheduler/admission `R` channels exclude telemetry |
| package-DAG + closure invariants (`14`) | `tests/architecture/package-dag.test.ts`; `tests/architecture/p12-closure.test.ts` | package DAG holds; CI-1..CI-7 asserted; every `planning/gaps/P12-*.md` absent or `CLOSED` |
| P11 residual amendments (TR-1 + G8/DF-16, `05`/`01`) | `tests/architecture/p11-closure.test.ts` (amended) | `advanceAnchor` absent from the ports public surface; adapter edges reconciled |

### 3.2 Completion blockers → tests

| # | Blocker | Test file | Test name |
|---|---|---|---|
| B1 | region-encoding correctness fix | `tests/p12-region-encoding.test.ts` | "resolver output resourceSpaceId ∈ {filesystem,database,external}, normalizedRegion object" |
| B2 | ToolCatalogPort inherited contract correction | `tests/p12-toolcatalog.test.ts` | "ToolCatalogPort returns model-facing projection; compiler emits no placeholder" |
| B3 | full §8.16A Runtime Safety closure | `tests/p12-runtime-safety.test.ts` | "D1–D6 each have the eight evidenced facets" |
| B4 | Authority Resolver production plane | `tests/p12-authority-resolver.test.ts` | "no path resolver → CommandGateway / repository write / approval consume / tool invoke" |
| B5 | SecretStorePort / SecretRef + real adapter | `tests/p12-secret-store.test.ts` | "driver no longer hardcodes secretRef; missing secret → SecretNotFound" |
| B6 | observability / health / usage plane | `tests/p12-observability.test.ts` | "no scheduler/admission code path imports telemetry; unknown cost → Unknown" |
| B7 | StorageScaleAssessment + DurabilityEnvelope | `tests/p12-storage.test.ts` | "PostgreSQL adapter absent unless verdict = PostgreSQLRequired; restore drill evidence" |
| B8 | Remote Worker transport / identity boundary | `tests/p12-remote-worker.test.ts` | "remote worker has no DB credential; transport version mismatch → typed rejection" |
| B9 | Plugin SDK / compatibility / trust model | `tests/p12-plugin-sdk.test.ts` | "PluginSdkApiVersion MAJOR mismatch rejected; unregistered project tool not invocable" |

### 3.3 Closure invariants → architecture test (E-22)

`tests/architecture/p12-closure.test.ts` additionally asserts the cross-phase closure
invariants (`00-contract-index.md` CI-1..CI-7) and that **every `planning/gaps/P12-*.md`
is absent or `CLOSED`** (no open P12 Design Gap may exist at closure).

Two further architecture suites carry the G8/allow-list and observability-boundary
evidence: `tests/architecture/package-dag.test.ts` (allow-list reconciliation: no
`verification-runtime` entry; adapters depend on `domain, ports` only, DID §10.4.1) and
`tests/architecture/p12-observability-boundaries.test.ts` (`04`: no scheduler/admission
import of the observability module; no telemetry in scheduler/admission `R` channels).

```text
CI-1  domain semantic mutation only via CommandGateway; runtime operational writes
      only via fenced Runtime ports (no resolver / observability / worker path
      mutates canonical domain state directly)
CI-2  no secret material reaches prompt / session / event / log / artifact
CI-3  no operational (metrics/log/health/usage) value is treated as authoritative
CI-4  every §8.16A safety dimension has mechanism + state + reset + rule + policy
      + violation action + durability + tests
CI-5  every P12 completion blocker is mechanically evidenced before P12 closes
CI-6  no tool placeholder in PortableModelRequest.toolDefinitions; the model-facing
      ToolDefinition is resolved via ToolCatalogPort (`07`)
CI-7  region encoding at every producer matches the frozen object encoding; narrow
      invalidation is reachable and tested end-to-end (`09`)
gaps  every planning/gaps/P12-*.md is absent or marked CLOSED
```

## 4. Completion blocker gate (frozen)

```text
P12 cannot close until every blocker is mechanically evidenced:
region-encoding correctness fix
ToolCatalogPort inherited contract correction
full §8.16A Runtime Safety closure
Authority Resolver production plane
SecretStorePort / SecretRef + real adapter
observability / health / usage plane
StorageScaleAssessment + DurabilityEnvelope
Remote Worker transport / identity boundary
Plugin SDK / compatibility / trust model
```

## 5. Must Not Decide

- No P12 implementation authorization before contracts are frozen (Blocking = 0).
- No weakening of P0–P11 frozen semantics; no distributed consensus.
- No closure while any `planning/gaps/P12-*.md` remains open.

## 6. Verification

```bash
pnpm test p12
pnpm architecture
pnpm check
```
