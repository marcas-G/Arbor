# F23 / P8 Permanent RetryVerification Origin — Governance Acceptance and Landing

状态：**Accepted design-only package landed; implementation NOT authorized**

## Decision

- Accepted token: `ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`
- Accepted fixed proposal raw SHA-256:
  `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`
- Decision/landing date: 2026-10-16
- Landing base: candidate `3be2e399ef8f9277d31bbdf18c11781d62e8f28e`

The acceptance authorizes only the fixed owning-document design landing and
the post-landing consistency review. It does **not** authorize production
implementation, DDL, schema/migration registration or execution, test
implementation, or online/preserved database upgrade. Those require separate
authorization after this landing.

## Fixed semantics landed

- P8 exact replay is conditional on current P12 visibility and current human
  authorization of the same original actor/source. Revoked or changed-owner
  authorization and changed actor/project/source are generic Resolver denials
  before Gateway and receipt lookup.
- The permanent P8 origin stores only CommandId, ProjectId, original actor,
  source Verification/Work, successor Verification/verifier Execution, and
  createdAt. It stores no receipt tuple, payload, summary, or JSON result.
- Composition loads only this non-receipt origin fact into declared Resolver
  inputs. Resolver is pure, checks current authorization and source scope, and
  does not compare candidate summary/revision/successor fields. Gateway
  `BEGIN IMMEDIATE` remains the sole receipt lookup and full-tuple comparison
  point. A changed tuple uses the existing non-disclosing
  `TerminalRejected(IdempotencyConflict)` receipt branch.
- Replay-only authority is not accepted by the P8 handler. An origin without
  its permanent receipt fails with safe `PersistenceCorruption<"CommandStore">`
  and zero handler/attempt/canonical/Event writes.
- Backfill requires the exact retained event pair, strict successful P8
  result, and canonical successor/execution facts. Unprovable recognized
  legacy successes retain their receipt, receive an immutable `UnboundLegacy`
  disposition, and an atomic human-only P6 Governance Inbox item. It is not a
  P10 Attention source or Agent instruction.
- The physical migration ID/name is explicitly TBD. Existing migration
  registries, high-water marks, online databases, production code, and tests
  are unchanged.

## Owning-document files landed

1. `docs/design/03-detailed-implementation-design.md` — DID v1.46 amendment,
   acceptance token/proposal basis, cross-phase summary and implementation
   authorization boundary.
2. `docs/design/implementation/P8/01-verification-commands.md` — P8 Story H
   current-authorized replay, permanent origin and legacy disposition.
3. `docs/design/implementation/P8/06-acceptance.md` — Story H replay/negative
   contract and legacy Inbox outcome.
4. `docs/design/implementation/P1/01-command-contracts.md` — external
   Resolver-before-Gateway order and replay-only missing-receipt disposition.
5. `docs/design/implementation/P1/03-transaction-model.md` — atomic origin
   write and missing-receipt/no-handler branch.
6. `docs/design/implementation/P1/04-sqlite-schema.md` — placeholder physical
   relations, FK/uniqueness/immutability/retention/backfill; successor
   verifier Execution FK is omitted because P8 admits it post-commit; no
   migration ID assigned or registered.
7. `docs/design/implementation/P12/02-authority-resolver.md` — declared
   origin snapshot and current authorization/source checks while preserving
   Resolver purity.
8. `docs/design/implementation/P12/10-transport-shells.md` — authenticated
   P8 route and non-receipt origin composition boundary.
9. `docs/design/implementation/P6/02-communication-protocol.md` — stable
   human-only, queryable `UnboundLegacy` Governance Inbox requirement. Exact
   entry kind/key, recipient, query/consumption and rebuild mechanics remain
   owner-gated by separate P6 acceptance; see the supplemental proposal below.

P10 files were not changed: this package chooses Governance Inbox and adds no
P10 Attention source. The accepted proposal and pending RED evidence remain
unchanged.

The supplemental P6 Inbox mechanics proposal is
`planning/proposals/F23-P6-unbound-legacy-inbox-mechanics-draft.md`; it is not
accepted by the P8 origin token and does not change this landing's authorization
scope.

## Verification boundary

The post-landing review is recorded in
`planning/results/F23-retry-verification-permanent-replay-design-landing.review.md`.
This landing ran documentation/reference consistency, exact-file/status,
`git diff --check`, and `docs/design` whitespace checks only. No code tests,
build, migration, database upgrade or online-database access were performed or
claimed.
