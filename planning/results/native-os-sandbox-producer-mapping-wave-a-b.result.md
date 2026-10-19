# Native OS Sandbox producer mapping — Waves A/B

Status: **A/B implementation complete; owner review pending.** This is a
focused implementation result, not a claim that Producer Mapping Wave C or
Native OS Sandbox convergence is complete.

## Wave A — closed codecs and producer KATs

Commit: `8415eb818504e5a690a5c886c334edbfb547a143`.

- Added closed, canonical provider-neutral codecs for object-valued
  `SandboxTargetRefV1`, complete `ResourceBoundaryDigestV1` inputs, target and
  handle binding preimages, exact broker-control variants, operator policy
  config, V2 authority bundle/high-water and V2 authority audit records.
- Updated effective policy snapshots to require object-shaped TargetRefs and
  exact network controls matching the selected NetworkPolicy mode. Historical
  string TargetRefs are not reinterpreted.
- Fixed KATs cover ResourceBoundaryDigest and TargetRef; V2 fixed bytes/digests
  cover operator config, full authority bundle, and high-water.

Verification: seven focused suites, 39/39 tests; `pnpm build`; `git diff
--check`.

## Wave B — P5 V2 exact-pair admission

- Production `SandboxAuthoritySnapshot` now consumes only the closed V2 source
  and V2 high-water pair. V1 loading remains available only under the explicit
  `loadSandboxAuthorityBundleSnapshotV1Forensic` name and is not wired to an
  authorization service. A V1 active high-water is rejected; no startup
  fallback or implicit V1-to-V2 reinterpretation exists.
- The V2 loader is read-only. It admits only a complete exact source/high-water
  tuple, reports a V2 audit record, and fails closed for source-ahead or
  mismatched revisions/digests. It does not perform V1→V2 provisioning.
- V1→V2 offline source writing, forensic V1 high-water preservation, durable
  atomic V2 high-water replacement, and OS-process kill qualification remain a
  separate operator/qualification slice: the existing trusted-source port
  exposes read plus high-water commit but no explicit offline preservation
  operation. No online or implicit upgrade was added.
- Migrations 0049/0050 create an empty immutable sandbox decision ledger on the
  supported 48→50 path. There are no supported pre-0049 decision rows. A
  stored result containing the prior candidate's string `targetRef` is rejected
  as `PersistenceCorruption`; only the accepted object-valued shape decodes.

Verification: V2/forensic P5 loader suites 8/8; domain producer/result suites
6/6; sandbox decision-store suite includes strict legacy-string rejection;
schema 0049/0050 disposable migration suite 5/5; P5 composition 1/1; `pnpm
build`; focused Biome and `git diff --check`. Full workspace suites were not run.

Remaining implementation slices include the offline V1→V2 operator transition
and process-kill proof, preparation adapter composition wiring, production
SQLite CAS/crash qualification, exact audit-ref end-to-end qualification, and
P1/P4/P9 consumer convergence. No Supported OS provider or fallback was
introduced.

## B review follow-up — V1 forensic path is read-only

The V1 forensic loader accepts only the narrowed
`SandboxAuthorityForensicReadPort` (`readVerifiedSandboxAuthorityBundle` and
`readSandboxAuthorityHighWater`). It does not accept audit or high-water commit
capabilities, emits no audit write, and fails closed when source is ahead of
the existing V1 high-water. The prior high-water advancement behavior is
removed; V1→V2 transition remains offline-only. Architecture and type-directed
tests guard this no-write boundary.

## Wave C — pure complete-boundary producer

The new domain-only `produceSandboxBoundaryV1` accepts the exact current
Workspace responsibility/resource-boundary revisions, the complete normalized
region set from P11, an independently resolved exact primary managed
GitWorktree, current ownership facts, and a closed policy kind/profile. The
production adapter calls P11 `observe` with the Workspace's exact full
`ResourceBoundary.addresses` and checks the resolver's `entries` against its
normalized region set; it does not reconstruct normalized paths from raw
address strings. The producer collapses canonical filesystem aliases and
rejects malformed source/region data, conflicting GitWorktree metadata,
digest identity collisions, malformed claims, active current claims outside
the boundary, and missing or mismatched primary worktree. It derives
path-free target refs for all admitted regions, deterministic filesystem-only
mounts and logical access, plus the ResourceBoundary and handle-binding
digests. No host path appears in the result.

`makeSandboxPolicyDecisionPreparation` now provides an independent production
adapter module: repository reads use short transactions; the full P11
resolution and materialization occur outside the Gateway transaction; the
final P1 preconditions re-read the exact Workspace/Episode/policy head/claims
and recompute mount binding from the captured resolver set without filesystem
I/O or nested transaction inside the existing P1 transaction scope. The
composition root wires this adapter by default using the verified V2 snapshot,
SQLite P11 WorktreeStore, and exact P11 resolver; the existing injection seam
is retained for focused tests. It supports only an explicit V2-configured
TrustedLocal decision today. OsEnforced fails closed when there is no exact
currently Supported tuple; it does not select or fall back. The authority audit
store exposes no stable record reference, so TrustedLocal records only the
exact P1 CommandId/receipt reference and OsEnforced would additionally require
its qualified evidence ref.

The V2 preparation integration test uses a fresh disposable schema-50 SQLite
Gateway and the real TransactionPort/repositories/immutable decision store. It
proves commit + exact replay + stale policy-head CAS without a nested
transaction. Its V2 snapshot is a deterministic test fixture; codec/high-water
admission is independently covered by the P5 loader suite.

Verification: six focused files, 25/25 tests across producer/codec, real P11
resolver-normalization, WorktreeStore, preparation and schema-50 Gateway
(11/11 preparation + Gateway tests); revision-zero ResourceBoundaryDigest and
V21 TargetRef vectors;
FileTree-first alias, relative/dot-segment path, observation consistency,
claims/access, source-boundary, Worktree selection, commit/replay/stale CAS and
no-fallback cases. SQLite WorktreeStore adapter tests 3/3. `pnpm build`, focused
Biome and `git diff --check` pass.

## Wave E — P4 current-policy consumer and P9/crash qualification

The production executable handler materializes a shell runtime policy only
from the joined current immutable P1 decision/result. Before invoking
ToolRuntime it reloads the active V2 authority/high-water pair, re-reads the
exact current Execution/Episode, Workspace, policy head, ownership claims and
managed Worktree, and re-runs the exact full P11 boundary resolver. It compares
the full V2 bundle/operator/provider snapshot, Workspace/boundary revisions,
ResourceBoundary digest, handle-binding digest, targetRefs/mounts/access and
policy basis. Host paths exist only in process-local runtime mounts; no path is
written to a receipt, event or public view. Any missing/stale/ambiguous source
returns `SandboxPolicyRequiredInterruption` before ToolRuntime invocation.

P4 opens the exact complete process mount set from those runtime bindings and
checks the actual SandboxHandle roots/access against the policy before effect
execution. The internal request is a closed union: OsEnforced uses only the
existing `SandboxProcessPort` capability resolution (Experimental OS providers
remain unavailable and never fall back); explicit TrustedLocalUnconfinedV1
uses a separate `TrustedLocalProcessPort` adapter and never enters provider
selection or `SandboxProcessPort`. TrustedLocal literals, current decision,
episode, bundle, handle and all mounts must match exactly. It is explicitly an
unconfined local process, not OS enforcement; limits are disclosure/best-effort
and no OS/resource-enforcement claim is made. The one trusted-local
`child_process.execFile` adapter is protected by exact import/callsite
architecture audit and a fixed source SHA-256.

The schema-50 child-process crash fixture now uses production
`makeSandboxPolicyDecisionPreparation` (real SQLite repositories/TransactionPort
and P11 WorktreeStore; P11 resolver is the deterministic fixture port). It
proves decision/result/receipt/event rollback when killed at the Gateway
pre-commit marker, atomic persistence when killed after commit, and exact
restart receipt replay without duplication. No online database is opened.
P9 tests cover durable unavailable fact/successor replay and strict V3 object
TargetRef decoding; the formerly string-shaped test fixture was updated to the
closed object codec.

Verification: `pnpm build` and `pnpm typecheck` PASS. Focused suites PASS:
ToolRuntime P4 76/76; TrustedLocal adapter 2/2; P9 successor recovery 3/3;
single-workspace handler + schema-50 Gateway 13/13; sandbox process boundary
architecture 23/23; V2/P11 fixture migration suites 60/60 (Persistence 10,
single-workspace 9, Application 28, Domain 6, command-result codec 7). Biome
on changed files and `git diff --check` PASS. Full `pnpm test` was not run.

## Offline V1→V2 provisioning qualification

Added the operator-only `sandbox:authority-upgrade` command, which requires
`--offline-v1-to-v2` plus explicit absolute protected-root, source, high-water,
forensic-directory, operator-config-file and source-identity arguments. It is
not imported or constructed by daemon composition and accepts no request,
workspace, daemon environment or DB inputs. The dedicated
`SandboxAuthorityProvisioningStore` is separate from the daemon's read-only
`TrustedHostConfigurationSource` capability.

The service first validates the exact V1 source/high-water pair using the
read-only forensic V1 loader, captures and preserves both raw canonical byte
strings with create-only/readback verification, and refuses non-exact operator
config. It carries issuer/provider children and their exact revisions/digests
forward, adds the explicit V2 operator config, and sets
`bundleRevision = oldV1HighWater.bundleRevision + 1`. It atomically writes the
V2 source, re-reads and decodes those exact bytes, then atomically replaces the
active high-water with the exact matching V2 tuple and re-reads both. It does
not initialize or roll back state on any failure.

The file adapter requires an existing protected root and pre-created forensic
directory, validates all explicit paths under that root, rejects reparse/symlink
paths and cross-volume/single-link violations, and uses the existing P39
owner/ACL validation. POSIX requires the current owner and exact 0700
directories/0600 files, and keeps same-directory rename plus file/directory
fsync. Windows evidence and active-file transitions use a fixed P39-owned
`MoveFileExW` helper: CREATE_ONLY uses WRITE_THROUGH and refuses existing
evidence; replacement uses REPLACE_EXISTING|WRITE_THROUGH. Its fixed PowerShell
script receives paths/flags as encoded environment data, not interpolated
script. P39 native-process scanner now audits and hash-locks both exact call
templates. The documented EPERM from Node directory fsync on Windows is kept as
the platform RED evidence; the Win32 path does not claim directory fsync.

On fresh P39-protected disposable directories, the explicit CLI success path,
invalid-config refusal, evidence-preservation/source-readback failure cases and
real child-process crash matrix pass. Before-high-water kill leaves exact V1
active high-water, V2 source ahead, both exact V1 forensic blobs, and V2 loader
Unavailable. After-high-water kill leaves the exact V2 source/high-water pair,
both V1 evidence blobs forensic-only, and V2 loader Available. Ordinary
unprotected TEMP was rejected by P39 checks; tests now use newly created P39
private directories. No online database was opened or upgraded.

Verification after this qualification: `pnpm build`, `pnpm typecheck`, and
changed-file Biome PASS; P39/native-spawn architecture 24/24 PASS; offline
provisioning CLI/failure tests 3/3 PASS; Windows before/after high-water
process-kill cases 2/2 PASS; `git diff --check` PASS. Full `pnpm test` remains
unrun.
