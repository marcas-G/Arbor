# Workspace authorization to exact execution policy

Date: 2026-11-16  
Baseline: `e7065a7c` plus the existing dirty worktree and this continuation.  
Status: staged domain/Application/Gateway/SQLite qualification; delivery remains open.

Subsequent production integration supersedes the staged status below. See
`docs/verification/2026-11-16-workspace-production-integration.md` for current
schema57, production/UI/admission work and its remaining acceptance limits.
The checks below remain evidence of their original checkpoint.

## Implemented boundary

- `BindWorkspaceSandboxPolicy` is an internal System command with exact resolver
  authority. It uses the current Workspace authorization revision and trusted
  host fields, not legacy human grant/issuer provenance. External/model wire and
  ordinary production registration are absent.
- Preparation receives only the host fields it actually needs. Existing
  preparation decoding, resource/host preconditions and snapshot validation are
  shared with the historical decision handler. Inside Gateway's transaction the
  binder rereads complete current authority, active/non-stopping execution,
  exact episode, source checks, current policy head and host/resource CAS.
- Selection must equal the Workspace choice. A finite policy cannot outlive a
  finite authorization. Revocation between authority resolution/preparation and
  commit denies the new request. Sensitive action approval remains separate.
- Exact result v3 adds `workspaceAuthorizationRevision`; its Linux effective
  summary remains v2. Complete UTF-8 size, canonical bytes and snapshot digest
  are checked. Historical `DecideSandboxPolicy` schemas reject v3. The internal
  binder schema1 decoder requires v3 and exact command/project identity.
- Policy event v2 carries Workspace provenance; event v1 remains supported for
  historical writers/readers. No aggregate authorization snapshot is put in the
  event. Event catalog qualification also now covers the prior authorization
  change event and its narrow Granted/Revoked discriminator exception.
- Staged schema57 atomically creates the Workspace ledger and rebuilds policy
  provenance into exclusive LegacyHumanGrant/WorkspaceAuthorization branches.
  The modern branch uses a real same-Project/Workspace revision FK and null
  legacy fields. Existing decision bytes, command receipts, retention triggers,
  exact keys and inbound provider-unavailable references are preserved. An
  in-transaction FK check makes detected corruption roll the entire rebuild back.
- SQLite reads distinguish actual legacy/modern table shape. Modern rows require
  schema1/v3 and matching authorization revision; mixed provenance, mismatched
  operator configuration or expiry fails decoding. Common public views and the
  provider-unavailable projection handle the version boundary explicitly.
- The generic typed-handler erasure wrapper now preserves preparation, the
  prepared argument, supported prior receipt versions and replay validation.

## Concentrated verification

Final command: `pnpm exec vitest run` with these nine files:

1. `tests/workspace-sandbox-authorization.test.ts`
2. `packages/application/test/decide-sandbox-policy.test.ts`
3. `packages/application/test/command-result-codec.test.ts`
4. `packages/domain/test/sandbox-policy-result.test.ts`
5. `packages/domain/test/events.test.ts`
6. `adapters/persistence-sqlite/test/sandbox-policy-decision-store.test.ts`
7. `packages/application/test/p1-gateway.test.ts`
8. `apps/single-workspace/test/sandbox-policy-decision-gateway.atomic.test.ts`
9. `apps/single-workspace/test/sandbox-policy-decision-preparation.test.ts`

Result: **9 files passed; 103 tests passed, 2 skipped; exit 0** (39.18 seconds).
The two skips are existing Windows-only preparation cases on Linux.

The new real-SQLite integration uses the actual Gateway, resolver, repositories,
event journal, command receipt store and staged migration. It commits a v3
decision, replays its exact receipt, reopens the adapter and reads the joined
decision. It then resolves another request while authorized, revokes through the
human Gateway command, and proves the already-resolved request is denied without
another policy/event. Host preparation is deliberately synthetic in this test;
this is not real OS sandbox qualification.

Populated migration qualification seeds valid FK relationships, a canonical V1
policy receipt and an inbound unavailable fact before the rebuild. It verifies
unchanged receipt bytes/legacy columns/facts, strict adapter read after reopening,
retention triggers and an empty FK check. SQL also rejects unknown/mixed authority,
FullAccess and missing authorization revisions; a real same-Workspace revision
passes within a rolled-back constraint probe. Breaking preexisting command FKs
causes the whole migration to roll back, retaining schema56, the old table and
its row, with neither new staging table left behind.

Unit/codec cases cover internal-only resolution, unavailable authority/host,
exact revision, selection enlargement, stale host/execution, policy expiry,
revocation after preparation, mixed provenance, cross-version rejection, digest
corruption and the exact full 65,536-byte UTF-8 boundary.

Other final checks: root `pnpm typecheck` exit 0; root `pnpm lint` exit 0
(1526 files); `pnpm architecture` exit 0 (38 files / 199 tests); manifest check
exit 0. Root lint/architecture were rerun after the handler-wrapper forwarding
fix. The final nine-file batch includes that fix and the additional migration
constraint probes.

## Failures retained

The first four-file batch had four failures: fixture provider/canonical ordering
and a descriptor-order expectation. The Linux v2 codec correctly rejects a
non-`linux-bwrap` fixture and noncanonical snapshot order; fixtures were corrected
without weakening production decoders or byte limits. Two subsequent typechecks
caught a fingerprint-input fixture field and a SQLite tuple-inference issue;
both were corrected.

The first nine-file batch had one actual integration failure: the generic
handler erasure wrapper dropped preparation behavior and its prepared argument.
The binder therefore rejected a valid request. The wrapper was corrected and
the entire nine-file batch passed. Earlier green subset checks are not presented
as the final integration result.

## Governance and remaining work

Product decisions: persistent Workspace authorization; bounded explicit direct
Parent allocation; only the human can undo a human Child revocation. Decision
record: `docs/decisions/2026-11-16-workspace-scoped-sandbox-authority.md`.
Engineering package:
`docs/proposals/2026-11-16-workspace-execution-policy-binding.md`, SHA-256
`9d3a968400d89bc9865ac92dd91e143f2390db6037ff4286a4a79d4385c267f4`.

Post-landing owning-document hashes:

| Owner | SHA-256 |
| --- | --- |
| DID | `b0f2972de13cd4fc2521e56927504bea9e661edf1e70a1cd9e1c9b407d80ad7a` |
| P1/04 SQLite | `e784f9f3c60716d046392b64b3c0a1a0b6e68b57424b06240851e4c9fbc5a783` |
| P4/03 Authority | `cb0fef4a44c13e9a5ef70fe20cb72a0b4bd7260d81f88e75622b612f029d7a55` |
| P12/02 Resolver | `86fe760c486d416af19706b94bb81b9f0dec878c2fa0fca53054bf4e5cd2cf9b` |

Self-review checked source ownership, exclusive provenance, no fabricated human
grant, unchanged Linux network codec and staged-only status. This is not an
independent Agent review or release closure.

Runtime remains **schema56**; 57 is unregistered. Automatic binding before
recovery/P4 gates, current authorization-chain checking on policy reuse/tool
admission, ordinary resolver/transport/UI, and upgrader/signature/manifest/
maintenance integration remain open. No preserved user database was upgraded.
No full `pnpm check`, full functional/browser batch or new installed real-model
shell/build/test journey was run. Reopening a connection does not prove process
crash recovery. The release-blocking two-human ordinary entry is still present
until the production slice replaces it.
