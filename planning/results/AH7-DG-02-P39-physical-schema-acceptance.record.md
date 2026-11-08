# AH7-DG-02 P39 Physical-Schema Supplement — Acceptance Record

Status: **FIXED SUPPLEMENT ACCEPTED; IMPLEMENTATION AND RELEASE NOT AUTHORIZED BY THIS RECORD**

This record accepts the reviewed physical-schema supplement as the fixed
physical realization of the already accepted AH7-DG-02 logical contract. It
does not change the D0A logical contract, authorize implementation, or assert
that any migration or deployment qualification has passed.

## Accepted package and authority

- Proposal: `planning/proposals/AH7-DG-02-P39-physical-schema-supplement-draft.md`
- Proposal LF SHA-256:
  `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`
- Accepted logical-contract proposal SHA-256:
  `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`
- Independent review: **Blocking = 0**. The review accepts the design
  package, while explicitly leaving Windows/deployment qualification open.
- Authority: the user's standing manual-governance delegation, relayed by the
  user-designated root agent. This is acceptance of the exact proposal hash
  above, not permission to invent further semantics.
- Review/acceptance baseline: DG02 independent tree at
  `701c01470dbb5e06c509e0a302d8330fcf7f7b2e` (`db929` line of work); this
  record is additive and does not modify the accepted proposal.

## Release and implementation gates

All gates below are mandatory. Passing this design review is not evidence that
any gate has passed.

1. **Ordered migration prefix:** P36 → P37 → P38 → P39. P39 depends directly
   on P36/P38 and is also ordered after P37 by the global `user_version`
   prefix. The DG02 independent tree contains P35/P36; P37/P38 are not
   integrated here. The green `C:\Arbor@f80` baseline contains only P35.
   Neither baseline may be described as having P37/P38/P39 or as ready to run
   P39 alone. Owner-document landing must wait for the governance integration
   dependency audit and its DAG.
2. **Windows/local-filesystem durability qualification:** Windows deployment
   remains blocked until the actual SQLite Node VFS/driver and target local
   filesystem pass process-kill, I/O-fault, VM hard-power-off, reopen, and
   integrity qualification for the sidecar audit database. SQLite `FULL`
   durability remains conditional on VFS, OS, and hardware honoring flush
   requests. No absolute power-loss guarantee is claimed.
3. **Filesystem admission:** network and unknown filesystems for the operator
   sidecar path fail closed until separately qualified. The path must satisfy
   the proposal's absolute-path, distinct-database, and sidecar-schema checks.
4. **Legacy active database cohort:** a P36 database containing an active
   `NotAdmitted` invocation without provable binding is reported to the
   operator sidecar and remains unchanged; the P39 preflight blocks it before
   the P37/P38/P39 migration prefix. That database is isolated from P39 for
   this deployment until future governance. This record does not claim its
   human recovery is closed, authorize fabricated binding, approval refund,
   deletion, or automatic retry. Release readiness must be assessed per DB
   cohort, not asserted as a blanket upgrade.
5. **Maintenance mode and lock protocol:** implementation must stop other
   primary-database writers across preflight and the ordered migration chain,
   preserve the reviewed primary→sidecar lock/commit/readback/rollback order,
   and fail closed on sidecar uncertainty or conflict.
6. **Terminal fact provenance:** every reconciliation-produced terminal
   Success, ExpectedFailure, or ReconciledNoEffect must enforce the reviewed
   selected immutable fact/attempt foreign-key relationship. Ordinary
   non-reconciliation terminal records may retain a null selected fact;
   legacy historical settlements do not acquire retrospective facts. The
   proposal's duplicate, conflicting, late-fact, and replay qualification
   matrix must pass before release.
7. **Separate implementation authorization and landing review:** production,
   migration, test, and owner-document changes remain separately gated. This
   acceptance record alone authorizes none of them. Owner landing awaits the
   integration audit DAG and subsequent landing consistency review.

## Scope and evidence boundary

This record changes no `docs/design/**`, production code, migration, or test.
No tests or deployment qualification were run for this acceptance-record
change. The physical supplement remains a proposal artifact until the gated
owner landing occurs; Windows and affected legacy-database release readiness
remain open as stated above.
