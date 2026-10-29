# P38 Executable Approval — Formal Closure

Date: 2026-10-16
Review baseline: `f289b7a1e5ce9731dbe54f52da381b197f1b13af`
Status: **P38 FORMALLY CLOSED**. This is module closure only; full release
qualification and repository-wide gates remain open/not claimed.

## Accepted P38/P39 matrix

| Contract area | Evidence and disposition |
|---|---|
| Exact request admission | Public approval journeys and the P4 issuance/runtime path establish one exact Pending approval for the active Execution/Step/action, revision-0 Inbox entry, request event/wake, and no ToolInvocation/effect while Pending. Same-action replay preserves the original ApprovalId and TTL. |
| Decision authority and one terminal winner | Public API cases cover Approve, Reject, expiry, unauthorized actor, and stale revision/replay. Route-specific resolver tests cover configured-human authority and exact direct-parent authority; wrong parent, foreign workspace edge, spoofed actor, and grant-without-parent negatives fail before Gateway receipt. Exact revision/state CAS is exercised against TTL/Stop by independent-connection races below. |
| P2 gate, same action, typed outcomes, Stop | Public/process and browser journeys resume the original Execution/AgentLoopStep/action/ToolInvocation. Reject and expiry become typed no-effect denials; Stop remains `Interrupted(StopRequested)`, including the committed-P4-Denied winner case. Pending paths assert zero effect. |
| P4 claim and replay | Same-Step claim tests assert exact invocation and approval identity, Worker lease fencing, one intent, one effect, and no duplicate claim facts. Kill-before-commit rolls back approval consume, intent, RecoveryBinding and attempt-0; post-commit restart reuses the committed claim and receipt without a second consume. Effect-before-settlement non-idempotent recovery retains the same consumer and does not replay the effect. |
| P39 receipt handoff | Real process snapshots compare the consumed approval with the canonical RecoveryBinding V1 projection: subject, exact expiry, target/action digests, pre/post revisions, consumer, identity tuple, binding hashes and attempt-0. Rollback and committed-replay cases are covered. P39 freshness tests cover exact current environment revision, one refresh, None/`"0"`, selected-region digest, ordering/multiplicity vectors, and final Workspace revision/address drift failing before writes. |
| SQLite lifecycle and concurrency | `p38-executable-approval-expiry.test.ts` runs eight barrier-synchronized independent-connection iterations each for human Reject-vs-TTL and Stop-vs-TTL. Each asserts exactly one state/revision winner, one event where required, and exact Inbox consumption. The public-process Stop-vs-TTL race runs twice with both TTL workers paused before `BEGIN IMMEDIATE`; the durable Stop cause and zero effect remain true for either approval winner. |
| Two-daemon arbitration | The real same-Step overlap pauses the owner at the exact P38/P39 pre-transaction point. The second daemon attempts `runExecution` and loses the live exclusive P2 lease before a claim transaction; assertions require it to write no P38/P4/P39 claim facts. The owner then commits one claim and produces one effect. This is correctly characterized as lease-layer arbitration, not two P39 transactions entering concurrently; adapter tests separately qualify transaction-level CAS races. |
| Browser Queue | Default Playwright Queue cases cover Approve, Reject and Expired display/recovery. The approved journey resumes the same action; canary/argument content is absent from the user-facing DTO/DOM; Reject/expiry produce no effect. |
| Migration | The cumulative disposable P37→P38 fixture proves ordered 0036–0038 application, historical approval preservation, FK/index integrity, no-op re-entry and clean `foreign_key_check`. The consumed legacy Control negative fails with the intended SQLite constraint error and leaves schema version/source rows unchanged. No preserved or online database was upgraded. |

The direct-parent authorization qualification uses the production
`AuthorityResolverPort` and external-submission composition, and asserts the
exact authority fact reaches Gateway only for the canonical parent/workspace;
wrong-parent and spoofed-actor requests are denied before Gateway. The P38
matrix requires this authority branch, but does not require a second live-HTTP
journey for the same resolver branch; the separate live public-process suite
qualifies the HTTP decision/receipt path for human authorization, stale and
unauthorized decisions, Approve, Reject, and expiry.

## Evidence references

- `planning/results/P38-layered-executable-approval-qualification.result.md`
- `planning/results/P38-cumulative-history-upgrade-fixture.result.md`
- `planning/results/P38-real-claim-and-stop-wave1.result.md`
- `planning/results/P38-P40-stop-terminal-winner.result.md`
- `planning/results/P38-wave2-public-freshness-migration-browser.result.md`
- `planning/results/P38-P39-final-matrix.result.md`
- `planning/results/P38-concurrency-qualification.result.md`
- `planning/results/P38-direct-parent-approval-authority.addendum.md`
- `planning/results/P43-P44-schema-activation-qualification.result.md`

The concurrency qualification record lists the exact commands and their
reported results: adapter/transaction target 5 passed / 6 skipped; public
Stop-vs-TTL 2 passed / 12 skipped; same-Step daemon overlap 1 passed / 13
skipped; typecheck and architecture qualification passed. The direct-parent
addendum reports 13 tests passed across the application resolver and external
composition files. The P39 final-matrix record reports 9 targeted P39 tests and
2 real-process claim tests passed. Earlier layer, migration, browser, public,
and schema-44 results record their targeted commands and counts. This review
did not run tests.

## Limits

No full `pnpm check`, full core suite, or full `pnpm test:functional` is claimed
by this closure record. It does not authorize deployment, migration of a
preserved database, or a release. P39 maintenance remains separately governed;
P43/P44 schema-44 qualification is limited to disposable test databases.
