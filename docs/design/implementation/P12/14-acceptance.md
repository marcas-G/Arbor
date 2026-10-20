# P12 — 14 Acceptance / Exit Criteria

**Authority:** DID v1.14 §11 P12, G1–G8, phase state; P12 completion blockers; P12 contract set `01`–`10`, `12`, `13`; P11 `00` (acceptance/closure pattern), P11 `06`/`13`; `planning/results/P8.result.md` (consumer-loop daemon wiring).
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox conformance addendum accepted under `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1`.

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

## Accepted Native OS Sandbox conformance gate

T2 provider bring-up is Experimental only. For each declared Supported
provider, P12/14 qualification must prove capability probe, exact admitted
read/write roots, network Disabled/Restricted/Enabled behavior including
DNS/IP pinning, redirect and bypass rejection, environment allowlist, whole
process-tree cleanup, and configured walltime/output/process/memory/CPU
controls. Include macOS Seatbelt, Linux/WSL namespaces/bwrap, Windows MXC and
each elevated/unelevated provider separately, plus container/remote contract
tests where claimed. Missing required evidence is Unavailable, not Supported.
This acceptance gate specifies evidence only; it neither performs provider
implementation nor authorizes release.


## V21 Native Sandbox T2/T3 qualification matrix

Acceptance evidence is per exact provider/version/capabilityRevision/OS build/
profile×networkMode tuple and matching enforcementRuleSetDigest; no independent
profile/mode arrays or inferred tuple is supported. Include canonical closed
registry/evidence codecs, high-water/source rollback/reuse and manifest/artifact
hash validation, all T3 control IDs/results, process-tree crash/kill, exact RO/RW
mounts, environment allowlist and every resource limit. Run each Linux/macOS/
Windows primitive separately. MXC/elevated Windows are probe-only Experimental;
absence of a required AppContainer/Job/broker/reparse control is Unavailable.
Container/Remote remain contract-only.

Network cases cover every fixed IPv4/IPv6 denied prefix, mapped-IPv6 normalize-
then-IPv4 classification, reserved/local/loopback/link-local/private, mixed
A/AAAA rejecting whole resolution, public IP pinning, certificate/SNI/Host
match, broker-only egress, redirect hops zero through five and rejection of six,
downgrade, DNS rebinding, raw IP/UDP/direct DNS/DoH/bypass. Restricted exact
origin and Enabled public HTTPS are qualified separately; Disabled verifies no
DNS/egress. Pref64 tests run a fresh discovery for each resolution/connection,
RFC7050 known answers for all six prefix lengths, explicit no-DNS64 proof for
empty result, malformed/timeout/unknown fail-closed and no pool reuse. T2
probe-only results never establish production Supported. No test may access or
upgrade a preserved database; schema 50 remains unchanged.


Authority/configuration acceptance covers immutable historical
SandboxAuthorityBundleV1 bytes under the strict V1 decoder and current
SandboxAuthorityBundleV2 plus nested issuer/operator/registry canonical
bytes/key order; every unknown/missing/duplicate/alternate string/number/
Principal encoding; sorted unique nonempty human issuer set; stable protected
source identity, ACL/reparse/truncation and atomic replacement; V1-to-V2
offline source/high-water preservation; high-water missing/corrupt/unreadable,
forward jumps, same-revision reuse/change, rollback, source reenrollment and
commit failure. It verifies one immutable snapshot is shared across
Resolver/Gateway after quiesced restart, with zero hot reload/default-allow,
fixed versioned load/rejection/audit ADTs, safe field filtering, and all audit
timestamps using injected GatewayNow.
Authority load, Decide command rejection, P4 provider-unavailable and P10
projection-integrity failures are tested as disjoint closed outcomes; no raw
source path, principal list, OS error, provider diagnostic or secret leaks.

## Accepted V3 producer mapping acceptance cases

Add these cases to the existing TDD/conformance matrix without changing the
V21 owner vectors or adding a schema/migration:

- Complete current ResourceBoundary, not caller-requested subset; canonical
  alias and duplicate collapse, UTF-8 order, identity-collision rejection,
  nonnegative `basisResponsibilityRevision` including zero, and exact
  `ResourceBoundaryDigestV1` revision-0/revision-7 hashes.
- Existing object-valued `SandboxTargetRefV1` remains `targetRef`; exact
  `/fixture/a` and V21 `3156810…`/`a5e1c895…` vectors, plus FileTree,
  GitWorktree, DatabaseNamespace and ExternalResource producer mappings.
  Optional `targetRefDigestV1` is distinct and never substitutes a string
  for the object.
- Deterministic mount materialization: only filesystem regions mount;
  primary managed GitWorktree ID `workspace`; extra region IDs
  `resource-<full-lowerhex-regionIdentityDigest>`; order, duplicate, collision
  and non-filesystem shell ResourceResolutionDenied behavior. Exercise RO,
  WorkspaceWrite exact active ownership and FullAccess unconfined disclosure,
  then separately enforce each tool's pinned required access.
- Exact SandboxAuthorityBundleV2/HighWaterV2/AuthorityAuditRecordV2 key
  order, bytes and subdigest mapping; V1 codecs stay byte-for-byte readable
  only as historical data. V1 source cannot authorize new decisions; V1 to
  V2 offline provision preserves issuer/provider/high-water values and fails
  closed across source/high-water crash boundary. operatorConfig revision and
  digest equal bundle fields/subobject hash; reject every
  `trustedLocalRuntimeVersion` except literal `builtin-v1`.
- Exact Restricted policy vector/hash above; exact Disabled and
  Restricted/Enabled broker-control bytes, including
  `FreshPerResolutionAndConnection`; no independent controls digest. Pref64
  discovery is fresh for every DNS resolution and connection and every
  redirect hop, usable only within that connection handshake, with no
  cross-resolution/connection/pool/hop reuse.
- Every Supported tuple's existing T3 artifact digest binds exact six
  configured limit values plus operatorConfig revision/digest and provider
  tuple; config change requires requalification. No missing maxima field or
  implicit platform-maxima behavior is accepted.
- Audit refs admit only existing stable authority audit ID (or omit if none),
  exact decision CommandId/receipt ref, and exact OsEnforced qualification
  manifest ref; deduplicate/sort/bound and redact publicly. Missing refs are
  omitted; no synthesized IDs or caller/provider diagnostics are accepted.

These cases qualify the accepted V3 producer semantics only. They do not
claim any current host/provider Supported, activate migrations 0049/0050,
upgrade a database, or authorize release.

## Accepted Windows T3-D D2 operator-trust qualification cases

The accepted `T3D-DG-01` proposal
(`ACCEPT_NATIVE_OS_SANDBOX_WINDOWS_OPERATOR_TRUST_V1`, SHA-256
`EAA9430B87462658D7B475C3D469425C5DB2BE0069A4D51634FD9C7FC3BA2039`)
adds these evidence cases to the existing per-tuple T3 matrix. They do not
substitute for any filesystem, network, Job, Stop or broker case above.

- Verify the closed V3 trust-set/HighWaterV3 canonical source under P5 owner,
  ACL, source identity and monotone revision. Operator-only V2→V3 offline
  migration preserves exact V2 source/high-water forensic bytes; interrupt
  before/after atomic commit, missing high-water, rollback, same-revision
  reuse and source replacement all fail closed with no V2 fallback.
- Verify detached sidecar canonical bytes and the exact domain-separated
  Ed25519 message over canonical manifest bytes. Missing, malformed, wrong-
  key, wrong SPKI hash, empty/tampered signature, unknown `keyId`, expired,
  Retiring-for-new-evidence and revoked keys all reject. A manifest- or
  caller-supplied key and a digest-only test callback cannot establish
  operator provenance.
- Verify current source, compiler, actual shipped PE and separate test/control
  artifact hashes, complete T3 matrix, exact registry manifest ref, provider/
  version/capability/Windows build/profile×network/rule-set/configured limits,
  and current trust-set revision at both probe and effect admission. A key
  rotation/revocation advances the protected source/high-water and registry/
  capability revisions; stale policy or cached-green capability cannot launch.
- Verify missing/unreadable/ambiguous trust source, source/high-water drift,
  wrong build and failed reenrollment yield typed Unavailable without key,
  path or exception disclosure. Legacy V2 deployments stay Experimental/empty
  for Windows; no unsigned historical row is retroactively promoted.

D2 signature/source qualification alone does not authorize Supported, a
production helper launch, Restricted/Enabled broker behavior or release.
Independent D4–D6 evidence remains required.

## Accepted Windows T3-D D2 V3 physical qualification cases

`ACCEPT_WINDOWS_T3D_D2_V3_PHYSICAL_CONTRACT_V1` accepts the exact physical
contract in `planning/proposals/native-os-sandbox-windows-t3d-d2-v3-physical-contract-draft.md`
(SHA-256 `2D77149B4C8757C6DC307A1A8C6F0873057E96908E6D77D499BDBBA081254A6F`).
The following cases qualify that contract, in addition to the operator-trust
cases above:

- Assert the *full canonical bytes* and SHA-256 of the TrustSetV1
  (`be159a9cfea6d65bf27b6645f94bbe12efa65b7d7ffe513d53477ed48241ea4d`),
  AuthorityBundleV3 (`5971402bc958c5f99cd1cdeeca95f364e161821945fb05dc0f8ea642d2399954`),
  HighWaterV3 (`deb5867f939177d2a077c780d245aee91e6d4f8b9b9ba71c7b5a0b364fb2f27e`)
  and detached sidecar (`b705caabef17937aa3606ea4fbaa14be3e8670bb3c9955337e57cd6817fe6977`).
  Keep the D1 canonical manifest KAT
  `e502199edae3e7b74c9fe6bd9681d727f537585b99d1b5983bbf9b013b4af234`
  separate. Reject noncanonical key order, whitespace, duplicates, variants,
  wrong identity/provider, invalid SPKI, invalid key cardinality and revoked
  key inconsistencies.
- Verify the exact domain-separated Ed25519 message and key-selection rules.
  Missing or invalid host time, unknown, future, expired, Retiring or revoked
  key, wrong SPKI hash, altered bytes and invalid signature all fail closed as
  typed Unavailable without raw key, signature, path or exception disclosure.
  The injected digest-only test verifier is never production provenance.
- Prove V2→V3 operator cutover at both sides of source write and high-water
  commit with independent-process reads and kill/restart. Preserve exact V2
  forensic bytes; V3-source/V2-high-water mismatch has no V2 fallback.
  A V2 Windows Supported registry row cannot carry into V3: a newer registry
  must remove that status before cutover. Reject rollback, replay, missing
  high-water and same-revision changed bytes.
- Prove rotation/revocation with source, bundle, registry and capability
  revision advances; stale signature, policy or cached-green capability cannot
  authorize effect. Re-read current protected source, sidecar and PE at probe
  and admission, rejecting a change between them. The same immutable current
  V2|V3 authority snapshot reaches P1, P4 and P10; V3 complete-bundle
  revision/digest, not a V2 shadow, bind active decisions.

Record the OS build, source identity, KAT bytes/hashes, crash points and real
process counts in the D2 result. Full `pnpm check` and clean install/package
smoke are required for D2 closure. D2 does not prove D4–D6 helper execution,
filesystem lifetime, Disabled network, Stop or broker gates; Windows remains
Experimental/empty/Unavailable and no Supported tuple is created.
