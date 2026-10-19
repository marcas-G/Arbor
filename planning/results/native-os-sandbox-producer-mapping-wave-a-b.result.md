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
and process-kill proof, P11 complete boundary/mount/access producer, production
preparation/materialization with exact CAS/audit refs, and P1/P4/P9 consumer
convergence. No Supported OS provider or fallback was introduced.
