# P12 — 00 Contract Index

**Authority:** DID v1.14 §11 P12, §2.1, §6.3, §7.2/§7.5/§7.6/§7.9, §8.4/§8.5/§8.16A, §9.1/§9.7, §10.1/§10.2/§10.4.1/§10.5, §12.3/§12.10, §13; v1.13 G4/G6; v1.14 G1–G8; SD v1.3 §6.1/§6.2/§7.7/§8/§8A/§10.2/§10.7/§12/§13/§14; P0–P11 contracts.
**Status:** **FROZEN** — four independent review rounds complete; **Blocking = 0**.

## P12 scope (DID §11 P12)

```text
Plugin SDK / SPI（PluginId / PluginVersion / PluginSdkApiVersion + compatibility policy）
Project tool explicit registration（content/version-bound trust；project-local 不自动可信）
Authority Resolver production plane（pure/deterministic；只产 trusted facts）
more providers/tools
remote Worker（single-writer control plane；WorkerId + WorkerIncarnationId）
StorageScaleAssessment + DurabilityEnvelope / backup-restore / RPO-RTO / restore drill
observability / health / usage（derived operational state）
Runtime Safety Envelope 六维补全（§8.16A cross-phase closure）
security hardening
performance
```

## Phase state (explicit)

```text
P12 design closure COMPLETE (contracts FROZEN; four-way review Blocking=0)
P12 planning COMPLETE (phase plan + task contracts; planning review Blocking=0)
P12 implementation NOT AUTHORIZED (explicit authorization required)
```

## P12 completion blockers (must remain explicit throughout closure)

```text
1. region-encoding correctness fix
2. ToolCatalogPort inherited contract correction
3. full §8.16A Runtime Safety closure
4. Authority Resolver production plane
5. SecretStorePort / SecretRef + real adapter
6. observability / health / usage plane
7. StorageScaleAssessment + DurabilityEnvelope
8. Remote Worker transport / identity boundary
9. Plugin SDK / compatibility / trust model
```

## Governance decisions (v1.14 G1–G8) → placement

| G | Decision | Placement |
|---|---|---|
| G1 | Plugin SDK/SPI + `PluginId`/`PluginVersion`/`PluginSdkApiVersion` compatibility; Project tool explicit registration + content/version-bound trust | `01` |
| G2 | Authority Resolver production plane (pure/deterministic; no CommandGateway/mutation/approval/tools); `SecretStorePort` correction | `02`, `03` |
| G3 | §7.6 authoritative: `ToolCatalogPort` resolves model-facing `ToolDefinition` | `07` |
| G4 | P12 owns operational Observability/Health/Usage (derived, non-authoritative; unknown cost ≠ 0) | `04` |
| G5 | SQLite default; `StorageScaleAssessment`; DurabilityEnvelope/backup/RPO-RTO/drill | `05` |
| G6 | Remote Worker; single-writer control plane; `WorkerId`+`WorkerIncarnationId`; no direct DB | `06` |
| G7 | §8.16A six-dimension completion gate | `08` |
| G8 | No `verification-runtime` package; physical catalog corrected (DID). Correction also removes the stale `verification-runtime` entry from `tests/architecture/package-dag.ts` `ALLOWED_EDGES` and reconciles `environment-resolver-local` / `sandbox-worktree` to `adapters/* → domain, ports` (DF-16, F3) | `01` |
| — | region-encoding correctness (P11 convergence C2) | `09` |
| — | transport shells (v1.13 G6); cross-phase daemon/transport deferrals | `10` |
| — | more providers/tools | `12` |
| — | security hardening + performance mechanism | `13` |
| — | performance assessment artifact (measurement / verdict) | `05` |
| — | acceptance / exit criteria / blocker gate | `14` |

## Documents

| Doc | Owns |
|---|---|
| `01-plugin-sdk-spi.md` | Plugin/SPI identity, compatibility policy, plugin categories, Project-tool registration + trust |
| `02-authority-resolver.md` | Authority Resolver production plane; `PermissionGrant` store; External Stop/Admit resolution |
| `03-secret-store.md` | `SecretRef`/`SecretMaterial`, typed failures, adapter, no-leak invariant |
| `04-observability-health-usage.md` | Operational observability/health/usage plane (derived) |
| `05-storage-scale-durability.md` | `StorageScaleAssessment`; SQLite default; DurabilityEnvelope/backup/RPO-RTO/drill |
| `06-remote-worker.md` | Remote Worker transport, identity, single-writer mediation |
| `07-toolcatalog-model-facing.md` | `ToolCatalogPort` model-facing resolution (inherited correction) |
| `08-runtime-safety-completion.md` | §8.16A six dimensions with the eight evidence facets |
| `09-region-encoding-convergence.md` | Region encoding correctness (P11 C2) |
| `10-transport-shells.md` | HTTP/WS/CLI/web shell/auth/deployment transport |
| `12-providers-tools.md` | more providers/tools: additional `ProviderPort` / `CanonicalProviderEvent` adapters + tool additions |
| `13-security-performance.md` | security hardening + performance |
| `14-acceptance.md` | P12 acceptance story, exit criteria, blocker gate |
| `00-contract-index.md` | this index |

## Cross-phase deferrals owned by P12

| Deferred surface | Source | Placement |
|---|---|---|
| recovery daemon / composition surface | P9 `00`:43 | `10` |
| consumer-loop daemon wiring (verification/completion, offset-driven) | `planning/results/P8.result.md`:63 | `10` |
| production daemon | P8 `00`:33 | `10` |
| drift-watcher probe trigger | P11 `05` §2 | `10` |
| snapshot pruning / retention policy | P11 `02` §3 (:28) | `05` |
| Search view semantics (P10-owned, unfrozen) — **out-of-v1 deferral**; P12 delivers transport mechanism only, never query/index semantics | P10 `01`:19 | `10` |

## P11 convergence item disposition

| P11 convergence item | Disposition |
|---|---|
| region encoding (C2) | `09` |
| `advanceAnchor` residual exposure | `05` |
| `parseSnapshotBlob` mtime roundtrip | `05` |

## Boundaries (explicitly out of P12)

- Canonical domain semantics (DID-owned); view semantics (P10); dependency coordination (P7); verification verdict/acceptance (P8); P9 runtime fault hardening; new distributed consensus / multi-writer control plane; `verification-runtime` package; changes to frozen P0–P11 command/port semantics beyond the corrections listed in §completion blockers and the tracked P12 contract revisions below.

## Tracked P12 contract revisions (F4, F9, NEW-11)

Revisions P12 explicitly owns against frozen P0–P11 contracts or the frozen DID
§7.2 port catalog. None is an implementation choice; each is contract-visible.

| # | Revision | Frozen surface | Placement |
|---|---|---|---|
| TR-1 | `advanceAnchor` removed from the public `ports` surface (advancement reachable only via the REC internal capability) | P11 `01`; `planning/results/P11.result.md:55` | `05` |
| TR-2 | `parseSnapshotBlob` replaced by a collision-free structured encoding (ISO mtimes containing `:` round-trip exactly) | P11 `02`; `planning/results/P11.result.md:57` | `05` |
| TR-3 | required `ContextFragment.provenance` field (`InformationTrustMetadata`) — source-breaking / MAJOR at the model-context boundary (not additive) | P3 `02` §10 / DID §8.4A | `13` |
| TR-4 | `ProviderFailureKind` **closed** union (add/remove/rename = MAJOR SPI change) + `ModelCapability` optional fields; six frozen tags keep their retry dispositions | P3 `01` §6/§8 | `12` |
| TR-5 | `UsageReq` row `cost` (hardcoded `0`) → `UsageCost` ADT (`Unknown` ≠ `0`) | P10 `05` §1 / SD §7.7 | `04` |
| TR-6 | `HealthPort` added to the frozen DID §7.2 port catalog (P12 addition; declared in `packages/ports`) | DID §7.2 | `04` |
| TR-7 | migration-baseline advance: P12 ordered migrations `0011_lease_worker_incarnation` (`06`), `0012_permission_grants` (`02`), `0013_project_tool_registry` (`01`); `PRAGMA user_version` 10 → **13** (`== max(applied id)`) | P1 `06` §5 / P2 `04` §3.2 | `06`, `02`, `01` |
| TR-8 | `VerifiedRuntimeCommandAuthority` external-origin widening (`AdmitExecutionAuthority` / `StopExecutionAuthority` add `"External"`) | P2 `01` §2 / P2 `00` R1 / DID §4.1 | `02` |
| TR-9 | lease-triple port evolution: `LeaseRecord` + `ExecutionRepository.{tryAcquireLease,renewLease,releaseLease}` + `LeaseService` + `SessionRepository.appendEntry` fence + `FenceStopCheck` gain `worker_incarnation_id` | P2 `02` §3/§6, `03` §2, `04` §3.2 | `06` |
| TR-10 | optional `RuntimeSafetyObservation` channel widening the frozen P2 `RuntimeSafetyGate.admitActivity` (additive third argument) | P2 `02` §5 | `08` |
| TR-11 | `ToolCatalogPortService.definitions()` → `visibleRefs()` + `resolveForModel()` (model-facing resolution; P12 completion blocker #2) | P3 `01` §1/§2; P4 `01` §1 | `07` |

## Recorded clarifications (review dispositions)

| # | Clarification |
|---|---|
| P12 cross-contract completeness correction | `01` §5.2 / `07` §2: add the committed-read enumeration seam `ProjectToolRegistry.listRegisteredToolDefinitions(projectId)` (no `TransactionScope`) and freeze `CataloguedTools = Builtins ∪ CommittedRegisteredProjectToolDefinitions` for `visibleRefs`/`resolveForModel`. Registry identity `(pluginId, pluginVersion, contentHash)` and `ToolDefinitionRef(name, version, hash)` remain intentionally distinct. Governance-approved targeted correction; no DID change, no closure reopen. |


| # | Clarification |
|---|---|
| NEW-9 | DID §9.1 `multiRuntimeConcurrentWrite` is **retained as a trigger candidate, non-v1**: it is not in the v1 actionable trigger union (`05` §3 `DbHa` / `SqliteWriteContention` only) and is governance-gated — a future multi-writer deployment is a DID control-plane governance change, not a P12 implementation option. |
| NEW-11 | The `HealthPort` catalog addition (TR-6) and the migration-baseline advance (TR-7) are explicit P12 contract revisions, not silent implementation choices. |
| F1 | Search view semantics are **P10-owned and unfrozen** (`P10 01`:19). P12 records Search as an **out-of-v1 deferral** (cross-phase table above) — **not** a Design Gap — and implements no Search surface; supplies the transport binding only if/when P10 freezes a Search view contract. `10` §2 records the same disposition ("not a Design Gap"; see `14` §1 item 11 / EC-11). |

## Exit-criterion / architecture-test mapping (F3, F10)

| Target | Owner | Test file | Assertion |
|---|---|---|---|
| allow-list reconciliation (G8/DF-16): remove stale `verification-runtime`; reconcile `environment-resolver-local` / `sandbox-worktree` application edges | `01` | `tests/architecture/package-dag.test.ts` | no `verification-runtime` entry; `adapters/*` edges are `domain, ports` only (DID §10.4.1) |
| observability boundaries (G4) | `04` | `tests/architecture/p12-observability-boundaries.test.ts` | no scheduler/tool-admission import of the observability module; R channels exclude telemetry |
| package-DAG + closure invariants | `14` | `tests/architecture/package-dag.test.ts`; `tests/architecture/p12-closure.test.ts` | package DAG holds; CI-1..CI-7 asserted; every `planning/gaps/P12-*.md` absent or `CLOSED` |
| P11 residual amendments (TR-1 + G8/DF-16) | `05`, `01` | `tests/architecture/p11-closure.test.ts` (amended) | `advanceAnchor` absent from the ports public surface; adapter edges reconciled |

## Cross-phase closure invariants (review targets)

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
```

## Contract review (independent, four-way)

| Round | Scope | Result |
|---|---|---|
| 1 | four-way (fidelity / coverage / executability / risk) | 9 Blocking + materials — repaired |
| 2 | four-way re-review | 5 Blocking + materials — repaired |
| 3 | four-way re-review | 3 Blocking + materials — repaired |
| 4 | blockers + consistency | **0 Blocking** (materials/lows repaired) |

**Blocking = 0.**

## Status

**FROZEN.** Four independent four-way review rounds complete; **Blocking = 0**.
P12 planning is COMPLETE (`planning/phases/P12.md` + 13 task contracts; planning
review Blocking = 0). P12 implementation remains **NOT AUTHORIZED** until
explicitly granted.
