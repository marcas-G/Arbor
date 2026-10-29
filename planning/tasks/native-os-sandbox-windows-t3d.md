# Windows native sandbox T3-D fixed implementation plan

Status: **PLANNING ONLY / NO PRODUCTION START AUTHORITY**. Prepared 2026-10-19
from clean `81663a4e6a88cce53df14d84472412c8478a4b0f`. T3-C implementation
and evidence: `7737217a`, `cede0b02`, `81663a4e`, and
`planning/results/native-os-sandbox-windows-t3c-seam.result.md`.

This plan stays below the accepted V21/V3 contracts in `docs/design/**`; it
does not amend them. The two T3-C blocking facts remain: a held Windows path
handle did not prevent a concurrent rename, and the no-capability loopback
probe timed out without an explicit denial code. A checked candidate is not
launch authority. `windows-restricted-appcontainer-job` and both probe-only
Windows identities remain Experimental, publish empty tuples, and return
typed Unavailable through every T3-D partial implementation.

## 1. Authority and artifact contract

The operator provisions a **production helper bundle**, distinct from the
T3-C diagnostic `WindowsSandboxBridgeHarness.cs`. Its proposed fixed package
paths are `src/native/WindowsSandboxProcessHost.cs`,
`dist/native/WindowsSandboxProcessHost.exe`,
`dist/native/qualification-manifest-v1.json`, and
`dist/native/qualification-manifest-v1.sig`; the existing fixed Framework64
compiler path remains the only compiler candidate. The implementation uses
these installed package locations for the production source/build record,
binary, canonical qualification manifest, and detached operator signature;
no PATH search, user/caller path, environment override, PowerShell fallback,
on-demand compilation, or diagnostic-harness execution is allowed. A missing
accepted provenance/signature scheme is a failed gate, not a reason to treat
matching bytes as authority.

`WindowsNativeArtifactManifestV1` is an artifact inside the existing T3
qualification evidence, not a second registry or permission source. Its
strict canonical UTF-8 JSON codec has a closed ordered field set covering:

- `version=1`, exact `providerId=windows-restricted-appcontainer-job`,
  providerVersion, positive numeric capabilityRevision, `osFamily=Windows`,
  exact osBuild, and closed platformPrimitiveSetId;
- one exact `ReadOnly|WorkspaceWrite × Disabled` tuple per qualification row,
  networkPolicyCodecVersion 1 and enforcementRuleSetDigest;
- source SHA-256, compiler file SHA-256/version, exact compiler argv template
  digest, actual shipped PE SHA-256, build method/version, and separate hashes
  of every test/control artifact;
- exact six configured limits (`wallTimeMs`, `stdoutBytes`, `stderrBytes`,
  `processCount`, `memoryBytes`, `cpuTimeMs`), operatorConfig revision/digest,
  discovery method/version, matrix IDs/results, and the current exact host
  controls proven by those artifacts.

The manifest contains **no self digest or `qualificationEvidenceRef`**. The
loader computes SHA-256 over the canonical manifest bytes and requires the
operator-issued registry row's `qualificationEvidenceRef` to equal
`blob:sha256:<that digest>`. A detached signature/provenance record binds the
same bytes and is verified against an accepted operator trust anchor before
the row can be considered; the adapter must not invent that trust anchor from
the manifest. All artifact bytes are independently hashed and checked against
the manifest. T3-C observed that two same-source/same-compiler builds had
different EXE hashes, so the shipped PE digest is mandatory and cannot be
derived from source.

Decoder acceptance is exact byte round-trip: no BOM, whitespace variants,
duplicate/unknown/missing keys, alternate key order, invalid UTF-8,
noncanonical numbers, wrong casing, path interpolation, or relative artifact
identity. `lstat`/final-path/read/hash errors, symlink/reparse substitutions,
source/compiler/binary drift, bad signature, OS-build mismatch, absent matrix
rows, or stale operator config produce typed Unavailable without raw path or
exception text. Source, compiler, binary, manifest, and signature are opened
from fixed locations and rechecked against the exact installed bytes. The
current read-only T3-C artifact seam remains unqualified until this chain is
implemented and independently reviewed.

## 2. Exact registry → snapshot → process-policy → capability chain

The existing V2 authority bundle's qualification registry is the only
operator selection source. Its Supported entry already binds provider ID,
version, numeric capabilityRevision, Windows build, exact tuple, rule-set
digest, and `qualificationEvidenceRef`; the existing materializer's
`exactSupportedOsProviderEntry` compares most of that entry with the committed
OsEnforced summary. **D0 must resolve a current implementation mismatch:**
the materializer compares `entry.tuple.enforcementRuleSetDigest` with SHA-256
of `encodeNetworkBrokerControlsV1(summary.networkBrokerControls)`, whereas
P12/13 freezes this field as SHA-256 of full canonical
`SandboxEnforcementRuleSetV1`. Add a failing full-rule-set vector, implement
the frozen codec/derivation in the owning layer, and require the exact full
digest before Supported. Do not treat a broker-controls digest as equivalent
or invent a new persisted authority field. If the accepted contracts leave
its source or ownership ambiguous, stop and raise a Design Gap.

T3-D adds `qualificationEvidenceRef` to the **internal/runtime-only**
`OsEnforcedSandboxProcessPolicy` in `packages/ports/src/sandbox-process.ts`.
`apps/single-workspace/src/sandbox-process-policy-materializer.ts` copies the
already validated summary field into it, with the exact
`blob:sha256:[0-9a-f]{64}` codec; TrustedLocal remains unchanged.
`packages/tool-runtime/src/runtime.ts` rejects a missing/malformed value
before effect admission. `SandboxProviderSelection` and
`resolveSandboxProvider` in `packages/domain/src/sandbox-policy.ts` gain an
expected qualification ref for the OsEnforced branch and compare it byte for
byte with `capability.probeEvidenceRef`. Update all affected OsEnforced
providers/tests, including POSIX fixtures, rather than making Windows a
special exception. Mismatch/absence is Unavailable
before `SandboxProcessPort.run`, with a distinct non-secret reason. The
materialized string form of registry numeric capabilityRevision is compared
exactly with capability revision; no coercion of arbitrary strings.

For a future Supported Windows Disabled row, the adapter's
`probeEvidenceRef` is the **verified registry qualificationEvidenceRef**, not
the current T2 host-discovery `sha256:` digest. T2 Experimental rows may keep
their diagnostic probe ref but can never pass the new Supported comparison.
The adapter probe first reads only the fixed installed artifacts and current
OS build, then verifies operator provenance, canonical manifest/ref, exact
registry row, and required host controls. A missing or failed stage yields
Experimental/empty or typed Unavailable; individual Boolean prerequisite
flags never promote a row. The probe must be re-evaluated against the current
installed bytes and trusted registry revision at admission, so a prior green
snapshot cannot authorize a replaced helper.
The adapter publishes only proven exact Disabled tuples: a single network
mode avoids inferring unqualified Restricted/Enabled combinations from the
existing `profiles × networkModes` capability shape. If only one profile is
qualified, publish only that profile. Any contradictory/duplicate registry
row, OS build, provider version, capability revision, rule digest, operator
config, tuple, artifact hash, or reference fails closed; do not choose the
"closest" row or fall back to TrustedLocal.

## 3. Production helper and enforcement gates

The production helper has a separate, bounded, versioned command/result
protocol. The adapter invokes only the fixed attested PE after the complete
policy/capability/manifest comparison; no shell is involved. It binds the
committed policy digest, execution/episode/handle, exact admitted mounts and
access, environment-name allowlist, network Disabled controls, six limits,
and qualification ref before any child process is resumed. Sensitive values
stay out of command-line arguments. A suspended child must enter its Job
Object before resume. The helper applies restricted low-integrity
AppContainer identity, zero network capabilities, an explicit inherited
handle list, UTF-16 environment block, exact DACL grants with finally
restoration, Job process/memory/CPU limits, bounded stdout/stderr and wall
time, kill-on-close, and typed cleanup failure. Tests must inspect the child
token, handle reachability, Job readback, whole-tree termination, and
post-failure ACL/profile cleanup rather than trusting helper echoes.

T3-C's path inspector is a **snapshot only**. Production filesystem access
needs an effect-lifetime primitive (for example, handle-relative opens/broker
operations with stable file identity) that rejects junction/reparse and
hard-link escapes and closes the observed rename-after-check window. It must
be proven under concurrent rename/reparse/hard-link attacks and Stop/restart;
revalidating a path just before spawn is insufficient. If the accepted design
does not determine an implementable authority/Stop boundary for such a
primitive, preserve Unavailable and raise a Design Gap with the T3-C
counterexample; do not silently change `docs/design/**`.

Disabled network requires repeatable proof that direct loopback, private,
link-local, reserved, and public attempts cannot complete, including a live
local listener and an OS-level cause/negative control adequate for the exact
Windows build. The T3-C two-second loopback timeout is insufficient. No
Internet capability is granted. Restricted/Enabled remain unadvertised until
the separate named-pipe-only broker, DNS/IP pinning, Pref64, redirect/TLS,
and bypass matrix qualifies each exact tuple. Broker absence must never open
direct network access, including in Disabled mode.

The current `SandboxProcessPortService` has `run` but no separate Stop method.
T3-D must map existing execution interruption/cancellation to a cooperative
helper Stop signal and bounded fallback that closes the Job handle and kills
the entire tree, then prove crash/restart and repeated Stop idempotence. It
must not add a public Stop authority or assume that Effect interruption alone
terminates child OS processes. If the owning runtime contract cannot carry
that mapping, stop at an implementation/Design Gap rather than widening the
port or claiming T3.

## 4. Ordered work and evidence gates

| Step | Owner files (planned) | Required qualification before next gate |
|---|---|---|
| D0 | domain rule-set codec/vector, `apps/single-workspace/src/sandbox-process-policy-materializer.ts`, tests | frozen full `SandboxEnforcementRuleSetV1` SHA-256 is derived and compared; broker-controls SHA is rejected as substitute; no design rewrite |
| D1 | `adapters/sandbox-windows/src/native-artifact.ts`, new strict manifest codec/tests, fixed package artifact paths | canonical/duplicate/extra/ordering/UTF-8 vectors; missing/delete/unreadable races; wrong source/compiler/argv/PE/signature/OS/tuple/limits/ref all typed Unavailable |
| D2 | adapter probe and trusted host composition; existing V2 registry loader | operator provenance plus exact manifest/ref/registry binding, no self-issued ref, no Supported capability from Boolean prerequisites |
| D3 | `packages/ports/src/sandbox-process.ts`, materializer, domain resolver, P4 runtime and their tests | exact registry→summary→internal policy→capability `probeEvidenceRef` join; every mismatch rejected before run; TrustedLocal and historical rows unchanged |
| D4 | distinct production native helper and adapter invocation tests | exact environment/handles/Job/ACL/limits/cleanup; no shell/fallback; crash and negative injection matrix |
| D5 | filesystem, Disabled-network and Stop real-process suites | race-resistant effect lifetime; explicit loopback denial; whole-tree Stop/kill and restart; exact host/tuple/config and independent evidence |
| D6 | operator manifest and independent review | all T3 control IDs and adversarial cases PASS; signed shipped binary/manifest; canonical digest/registry ref; only then one exact Disabled tuple may be considered for Supported |

D0–D5 can land as fail-closed partial checkpoints; **none** authorizes a
Supported row or a production `run` launch. D6 is a separate operator and review gate,
not an automatic result of green unit tests. Keep MXC and elevated dedicated
user probe-only. Full `pnpm check`, architecture, focused Windows native tests,
package/frozen-install artifact inspection, and real-process T3 qualification
are required at the appropriate gates; document exact counts, OS build,
source/compiler/binary hashes and unresolved cases without expanding a
targeted pass into a release claim.

## 5. Self-review before implementation

- Ownership: no `docs/design/**` edit, no new persisted field or authority
  source, no user-selected helper path, no V6 dependency. The manifest is an
  artifact bound by the already accepted registry evidence ref.
- Existing chain check: registry↔summary comparison is partly present, but
  its rule-set digest source is inconsistent with the frozen full rule-set
  codec. Runtime process policy lacks the ref and resolver lacks the
  capability-ref comparison. D0 plus those two links are required; the T2
  probe hash cannot serve as T3 evidence.
- Risk check: the current diagnostic bridge cannot be renamed into a
  production runner; T3-C race and loopback evidence are explicit blockers.
  Signature trust/Stop ownership and effect-lifetime file access are gates,
  not assumptions.
- Exit check: until D6 is separately satisfied, all three Windows providers
  remain Experimental/empty/typed Unavailable and the current production
  `run` function does not launch a process.
