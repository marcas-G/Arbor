# Native OS Sandbox First Release Boundary V1

Status: **FIXED GOVERNANCE / IMPLEMENTATION PROPOSAL — NOT ACCEPTED; NO DESIGN
LANDING OR IMPLEMENTATION AUTHORITY**

Date: 2026-10-26  
Proposal token: `ACCEPT_NATIVE_OS_SANDBOX_FIRST_RELEASE_BOUNDARY_V1`  

## 1. Decision requested

Set one fail-closed first-release contract for process-capable shell work:

1. Prefer one real `Supported` Native OS Sandbox tuple on the release host,
   selected only after its complete provider, artifact-provenance, trust,
   filesystem, network, process-tree, limit, Stop and recovery qualification
   passes. For the current Windows release path, the only candidate in scope is
   `windows-restricted-appcontainer-job`, initially `ReadOnly × Disabled` on
   the exact qualified Windows build. This is enough for the observed S4
   `Get-Date` action; it does not imply `WorkspaceWrite`, `Restricted`, or
   `Enabled` support.
2. If the exact signed production materials and full T3 qualification are not
   available by release cut, ship with **process execution disabled**. The
   model-facing shell tool is absent; runtime admission independently blocks
   any stale, replayed or otherwise received process-capable action before
   spawn. Show the existing typed unavailable/Attention path where an already
   durable action is blocked. Never select `TrustedLocal`, another provider,
   another tuple, or `FullAccess` as fallback.

The release choice is explicit and inspectable. A model-generated shell call,
action approval, Git worktree, policy candidate, T2 probe, synthetic V6 test,
or unsigned/missing helper bundle cannot establish Native support.

## 2. Evidence and boundary

The accepted contracts already establish that a Worktree is not an OS process
boundary; an unavailable required control means no process starts; and
`TrustedLocal + FullAccess/Unconfined` is an accurately disclosed explicit
choice, never fallback. No provider is currently `Supported`: the 2026-10-19
unified checkpoint records all five provider identities as Experimental with
empty tuples and typed Unavailable, and T3 open. Windows T3-D remains a
planning-only path with explicit held-handle rename and inconclusive loopback
negative evidence. Its plan requires a production helper separate from the
diagnostic harness, canonical qualification manifest, detached operator
signature/trust anchor, actual shipped PE hash, exact registry binding,
effect-lifetime filesystem defense, explicit network denial, process-tree
Stop and adversarial qualification before any `Supported` tuple.

The 2026-10-24 V6 profile-ownership review records a public pre-intent flow
where the real S4 model's unique `Get-Date` shell Action is Pending behind the
existing approval, but its post-approval provider outcome is synthetic
`ProviderVersionMismatch + NoEffect`. The V6 registry-drift/restart journey
passes for this synthetic provider and explicitly is not an OS-supported
provider or real OS sandbox qualification. The full S4 path still uses a
TrustedLocal/P11 fixture. Therefore this evidence proves model/tool routing
and fail-closed recovery, not Native enforcement.

Authority references: SD Native OS Sandbox V1–V21; DID v1.53–v1.57 (including
the V6 accepted landing); P11/04 and P11/12; P12/13 and P12/14; and
`planning/tasks/native-os-sandbox-windows-t3d.md`. This proposal does not
reinterpret those contracts, change P1–P14 ownership, or claim any current
host/provider support.

## 3. Proposed frozen release semantics

### 3.1 Closed configuration

Add one versioned, startup-loaded release setting at
`arbor.config.json.runtime.processExecutionMode`, owned by P12 composition;
its closed object is `{version: 1, processExecutionMode: ...}`:

```text
processExecutionMode = Disabled | NativeOsSupportedOnly
```

- Missing, malformed, unknown-version, unreadable, or contradictory config
  resolves to `Disabled`. There is no separate environment-variable or CLI
  mode override. The existing `ARBOR_CONFIG` path selector can locate the
  standard config file but cannot bypass Native trust, registry, tuple or
  admission checks.
- `Disabled` removes shell from the compiled model-facing tool catalog and
  blocks every process-capable invocation again at the P4 effect-admission
  boundary. It does not disable bounded in-process Read/List/Patch.
- `NativeOsSupportedOnly` exposes shell only when the current exact authority
  bundle/registry, operator trust, provider evidence, host build, policy tuple,
  and admission-time capability all verify. Otherwise shell remains absent
  and the public status is safely unavailable.
- The setting is immutable for a running daemon. No hot reload or cached-green
  capability is allowed. Changing mode requires controlled restart and fresh
  composition/probe. Human action approval remains independent and cannot
  enable the mode or widen sandbox policy.
- `TrustedLocal` remains a distinct existing policy contract but is not
  advertised or accepted as the release shell path in either mode. First
  release does not offer an unconfined bypass around missing Native materials.

If an older durable Execution already contains a shell Action when a process
starts in `Disabled`, it remains on the existing same-Execution blocked,
human-visible unavailable path; it is not discarded, retried under a weaker
provider, or rebound. Terminal evidence is the existing typed no-effect
provider-unavailable contract when a durable invocation already exists.
Newly received/decoded shell actions while disabled are rejected before
invocation intent or process spawn with a stable sanitized disabled reason.

### 3.2 Native Supported release gate

The only first-release Supported claim is per exact
provider/version/capabilityRevision/Windows build/`ReadOnly × Disabled` tuple
and matching full rule-set, operator-config and qualification-evidence
digests. Require all accepted T2/T3 evidence and D0–D6 from the existing
Windows T3-D plan, including:

- operator-provisioned signed production helper and canonical manifest, with
  accepted protected trust source; source/compiler/argv/PE/test/control
  hashes; no PATH, caller path, unsigned digest callback, on-demand build or
  diagnostic harness;
- exact registry → committed summary → runtime process policy → capability
  evidence-ref equality, verified again at effect admission;
- race-resistant admitted filesystem access, explicit Disabled-network proof
  including loopback/listener negative controls, and bounded whole-tree Stop,
  cleanup, output, wall-time, process, memory and CPU behavior;
- required real-process adversarial, crash/restart and clean package/install
  qualification on the exact release OS build, plus independent integrated
  review with zero blocking findings.

Only the one qualified tuple is advertised. Missing, stale, revoked, unsigned,
ambiguous or mismatched material maps to Experimental/Unavailable and no
spawn. Do not infer another tuple from profile/mode arrays, synthetic tests,
source-only builds or a T2 probe.

### 3.3 Upgrade and rollback

No database schema or migration is introduced by this release boundary.
Existing migrations 0049/0050 and the protected authority/trust cutover retain
their separately accepted ownership and sequencing; this proposal does not
activate or rewrite them. The config field has an exact versioned codec and
is read once at startup; invalid or absent configuration means `Disabled`.

Upgrade procedure: install the release in `Disabled`; verify the effective
mode and absence of shell from the model-facing catalog; provision and verify
the operator trust source, signed helper, manifest and exact registry evidence
offline; run the release-host qualification; then set
`NativeOsSupportedOnly`, quiesce/stop the daemon, and restart so the immutable
startup snapshot and fresh probe take effect. The Native mode is eligible only
after every required gate passes. Otherwise release remains in `Disabled`.

Rollback procedure: stop new admissions, settle or Stop active process trees
through existing execution interruption semantics, switch to `Disabled`,
restart, and verify no process-capable work is admitted. Preserve signed
evidence and monotone protected trust/authority high-water state; never roll
those records back to make an old provider appear valid. Returning to Native
requires a fresh current trust/registry/config snapshot and all gates again.
Code rollback must retain the same fail-closed default; it must not restore an
older implicit TrustedLocal shell path.

## 4. Fixed implementation and acceptance plan

After governance landing and independent owner post-review, implementation is
authorized only for this package:

1. P12 composition adds the closed startup setting, catalog suppression,
   status projection, and immutable mode binding. P4 admission independently
   blocks disabled/stale process-capable actions before spawn and uses the
   existing same-Execution unavailable/recovery path for already durable
   actions. No new persistence or authority source is added.
2. On Windows, follow the accepted T3-D D0–D6 ordering. If signed production
   material/trust cannot be obtained, stop at `Disabled`; retain all provider
   tuples Experimental/empty and typed Unavailable. Do not substitute a
   test-only key, local self-signing, unsigned release artifact, or
   TrustedLocal.
3. Qualify two release outcomes through public process APIs and the actual
   model path: (a) signed Native `ReadOnly × Disabled` S4 emits one exact
   `Get-Date`, is approved separately, runs under the qualified provider and
   survives the required restart/Stop checks; or (b) `Disabled` S4 advertises
   no shell, a forged/stale shell action is blocked before spawn, no provider
   or fallback is invoked, and the existing blocked-action status is
   inspectable. Also retain exact zero-process assertions for all missing,
   bad-signature, wrong-build, stale-registry, tuple, trust-revocation,
   provider-unavailable and rollback cases.
4. Add package/config codec vectors, model tool-catalog tests, P4 admission
   tests, public-process tests, real Windows provider tests, restart/Stop and
   rollback tests, and architecture checks for no direct executor spawn.
   Run the repository's required `pnpm check`, full `pnpm test:functional`,
   frozen-install/clean-clone smoke, and exact integrated Native qualification
   only when the matching host materials exist. Report each gate/count and OS
   build separately; targeted or synthetic passes do not imply release
   qualification.

Rollback acceptance is tested by switching a qualified Native installation
to `Disabled`, restarting with an active/stale action, and proving no new
spawn, no unconfined fallback, preservation of authority high-water/evidence,
and successful re-entry only after the full Native gate is current again.

## 5. Governance landing and fixed token

If accepted, land only the exact semantic package below, in the owning docs;
do not edit those files before acceptance:

- Scenarios: add the observable first-release Disabled/Native choice and
  blocked-shell behavior as a Native Sandbox scenario addendum.
- System Design: add the closed `processExecutionMode` semantics, default,
  capability exposure/admission split, and rollback invariant.
- Detailed Implementation Design: add P12 composition/P4 admission ownership,
  the exact startup/config and no-migration boundary, status mapping, and the
  conditional real-Native versus shell-disabled acceptance gate.
- Problem & Goals is unchanged; the new policy narrows the release's exposed
  execution capability without changing P1–P8 goals.

Acceptance token: `ACCEPT_NATIVE_OS_SANDBOX_FIRST_RELEASE_BOUNDARY_V1`  

Acceptance authorizes only the stated design landing and conditional
implementation plan. Existing Native implementation authorization remains
subject to its post-landing review and exact T3 gates. Any need to alter the
frozen threat model, weaken a T3 control, change authority ownership, or add a
new recovery/persistence contract is a separate Design Gap, not covered here.
