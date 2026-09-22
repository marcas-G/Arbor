# P12 — 13 Security Hardening / Performance (DID §11 P12)

**Authority:** DID v1.14 §11 P12, §8.4A (Information Trust Metadata), §8.16A (D5/D6), §9.1, §13 (empirical); SD v1.3 §8A (Information Trust Plane), §7.7 (resource control/usage), §10.7 (durability envelope), §14 No.45/No.54; P3 `02` §10, P3 `05` §4; P4 `04`; P11 `12`; P12 `02` (authority), `03` (secrets), `05` (storage assessment), `06` (worker identity), `08` (safety envelope).
**Status:** DRAFT.

## 1. Boundary (frozen)

```text
P12 enforces already-frozen invariants; it invents no new semantics.
Security hardening = Information Trust Plane at the context boundary + sandbox trajectory.
Performance       = declared operating envelope + measurement method + ceilings.
Mechanism is contract; numeric values are empirical (DID §13).
```

## 2. Information Trust Plane enforcement at the context boundary

`ContextFragment` currently carries no provenance; P12 makes trust explicit and enforced:

```ts
interface ContextFragment {              // BREAKING: required field added (NOT additive)
  readonly ref: string;
  readonly layer: ContextLayer;
  readonly retention: RetentionClass;
  readonly cacheClass: CacheClass;
  readonly tokens: number;
  readonly provenance: InformationTrustMetadata;   // P3 `02` §10 / DID §8.4A (NEW, required)
}
```

Constructor / SPI impact (R-15):

```text
Adding a REQUIRED `provenance` field is NOT additive:
  every existing ContextFragment constructor stops type-checking (source-breaking);
  any consumer/plugin that constructs a fragment is affected.
Classification: source-breaking (MAJOR) change to the model-context boundary contract.
  ContextFragment is not currently in the frozen plugin SPI surface (`01` §3), so this
  implies no PluginSdkApiVersion bump for internal construction; if fragments ever cross
  the plugin SPI as inputs, the required field is a MAJOR SPI change (bump
  PluginSdkApiVersion MAJOR, `01` §4).
Resolution: ContextFragment construction is centralized at exactly ONE context-boundary
  construction site — the model-context boundary fragment factory in
  `packages/model-context` — which is the sole place that assigns `provenance`.
  All other code receives already-tagged fragments (e.g. PrepareTurnInput.contextFragments)
  and never constructs them.
Assertion: no other construction path omits `provenance`. The required field makes
  omission a compile error, and a test/architecture check asserts ContextFragment object
  literals exist only at the single context-boundary factory (test fixtures construct
  through that factory or supply `provenance` explicitly).
```

- At the context boundary, `ToolObservation` / `ExternalRetrieved` / `Message`
  (AuthenticatedAgent / human input as data) / `ModelDerived` fragments are tagged
  `DataOnly`; only Runtime-compiled canonical governance/control may be
  `CanonicalInstruction` (DID §8.4A).
- `canRaiseAuthority(trust)` is **enforced** on the admission/planning path: a `DataOnly`
  fragment can never be promoted to `CanonicalInstruction` and never enters the `A0`–`A3`
  control plane.
- Enforcement is **code** at the context boundary (hard engineering rule 4), not prompt text;
  eviction/budget logic (`planContext`) must not drop or reorder trust metadata.
- Cross-references:
  - `02` — the Authority Resolver produces facts; trust metadata never raises authority.
  - `03` — `SecretMaterial` must not appear in any fragment (no-leak invariant, CI-2).
  - `06` — worker-originated observations remain `DataOnly`; worker identity never confers
    instruction authority.

## 3. Sandbox trajectory (P4 → P11 → P12; no new isolation semantics)

```text
P4  `04` : SandboxPort + minimal local executor (root-confined, region-confined,
           control-DB and secrets unreachable, close releases resources)
P11 `12` : worktree-backed adapter; advanced isolation = new adapters; SandboxPort unchanged
P12      : production sandbox composition; guarantees inherited verbatim
```

- `SandboxPort` / `SandboxHandle` semantics are **unchanged** (P4 `04`, P11 `12`).
- P12 hardens deployment/composition (adapter selection, root confinement, secret
  unreachability), not the isolation model.
- The sandbox is not an authority substitute: authorization/resource admission precede it.
- **Secret-unreachability via env allow-list (NEW-14).** `secret-env` is the default secret
  adapter (`03` §3): it resolves credentials from the process environment. Every sandbox
  adapter MUST therefore project an explicit **env allow-list** onto any spawned process, so
  ambient secrets — including `secret-env` values — are unreachable from sandboxed commands.
  This is the mechanism already implemented by `adapters/sandbox-local`
  (`SANDBOX_ENV_ALLOWLIST` + `sandboxEnvironment`, `adapters/sandbox-local/src/index.ts`);
  every sandbox adapter (e.g. `sandbox-worktree`) inherits the same projection requirement.
  Cross-reference: `03` §4 no-leak invariant / CI-2.
- Assertion: the spawned process environment contains only allow-listed keys; a sentinel
  secret present in the ambient environment is absent from the spawned process env.

## 4. Performance: declared operating envelope + measurement

```text
declared operating envelope : maxConcurrentRuntimes / maxWriteThroughput / maxDbSize /
                              availabilityTarget (P12 `05` §2 StorageScaleAssessment)
measurement method          : stated metric + method + workload per measurement
                              (no unmeasured verdict; DID §13 EMPIRICAL)
```

- The envelope + measurements + `verdict` are owned by `05`; `13` states the operating
  envelope is a **contract declaration** and the numbers are **empirical**.
- **Concurrency ceilings** (D5, DID §8.16A) and **rate / runaway protection** (D6) are
  enforced by the P2-owned Runtime Safety gate and completed per `08`; P12 wires ceilings
  into the provider/tool runtime composition without changing gating ownership.
- Usage/cost stays derived and non-authoritative (`04` §3); unknown cost remains
  `Unknown`/`None`, never `0`.

## 5. Which numbers are empirical (DID §13)

```text
EMPIRICAL (no contract change):
  SQLite performance ceiling                 -> StorageScaleAssessment (`05`)
  context/compaction numeric defaults        -> tune by eval (P3)
  retry counts / backoff                     -> P3 `06` §3, P12 `08` D1
  concurrency ceilings                       -> P12 `08` D5
  rate limits                                -> P12 `08` D6
  lease TTL / sweep intervals / poll batches -> P2/P9 config
  shell allow/deny lists and limits          -> P4 `08` §4
  model prices / price-sheet values          -> P12 `04` §3
CONTRACT (mechanism): the envelope declaration, the measurement method, the
  gating mechanism, the trust metadata, and the sandbox guarantees.
```

## 6. Invariants

```text
DataOnly fragments never raise authority (canRaiseAuthority enforced in code)
every ContextFragment carries provenance; trust metadata survives planning/eviction
ContextFragment construction centralized at the single context-boundary factory; no path omits provenance
SecretMaterial never appears in any fragment / durable / observable surface (CI-2)
sandbox guarantees inherited from P4/P11 unchanged; no new isolation semantics
every sandbox adapter projects an env allow-list; ambient secrets (incl. secret-env) unreachable
operating envelope declared + measured with a stated method; verdict justified
safety counters never auto-Cancel Work (CI-4, P12 `08` §4)
```

## 7. Must Not Decide

- No new trust model beyond DID §8.4A / SD §8A; no authority ladder change.
- No new isolation semantics or `SandboxPort` change.
- No concrete performance/rate/concurrency numbers as contract (empirical, DID §13).
- No usage-based automatic mutation; no safety-envelope auto-Cancel.
- No telemetry value treated as authoritative (`04`).

## 8. Verification

```text
ToolObservation / ExternalRetrieved / Message / ModelDerived fragment → DataOnly;
  canRaiseAuthority(fragment.provenance) === false
only Runtime-compiled canonical fragment may be CanonicalInstruction
ContextFragment provenance survives planContext selection/eviction (not stripped)
ContextFragment literals exist only at the single context-boundary factory; provenance set there
grep/CI: no SecretMaterial in fragment / session / event / log / artifact serialization
sandbox confinement + control-DB/secret unreachability tests (inherited P4 guarantees)
sandbox env projection: spawned process env ⊆ SANDBOX_ENV_ALLOWLIST; sentinel secret absent
StorageScaleAssessment carries envelope + method + verdict; numbers documented empirical
rate/runaway (D6) and concurrency ceilings (D5) drive Interrupted(RuntimeSafetyStop), Work Open
```
