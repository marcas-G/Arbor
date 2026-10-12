# P38 Executable Approval Module Closure — Progress Record

**Status:** PARTIAL; P38 remains OPEN
**Candidate:** branch `codex/p38-executable-approval-closure`
**Baseline:** v19 `ed5fba00ee60e169cadf0df12395179862abd1e8`
**Qualified source SHA:** `a921ac0b1c58e75ae4d6b62dcbb12e5c8b15700c`

This record keeps implementation and qualification evidence separate. It does
not claim that the former five public/browser checks close P38, and it does not
promote the still-unrun post-fixture-correction claim case to a pass.

## Scope and durable artifacts

- Module plan: `planning/tasks/P38-executable-approval-module-closure.md`.
- P38→P39 accepted RecoveryBinding receipt mapping and separate P39
  authorization boundary: `planning/proposals/P38-P39-executable-approval-receipt-handoff-dependency.md`.
- Proposed P4/P38→P39 `approvalTargetDigest` and
  `targetResourceIdentityDigest` projection Design Gap:
  `planning/proposals/P38-P39-RecoveryBindingV1-projection-gap-draft.md`.
  This draft has SHA-256
  `F3C243C9BB64B2B641AE31057A49ABA2677529E4743787451F83A1354BC756B6`.
  P39 owner review says it is faithful to D0A/D2FF/P4/06; it remains
  **unaccepted**. P39 implementation, migration, tests, and release remain
  separately gated.
- Crash-boundary and Stop/TTL test-source changes are in commits
  `2d1cf7216703bc6f8eee7250b5ecc59a1c0bd8fd`,
  `b2d0903a38ba107734c76eadb1c38f109c2eecf9`,
  `688e6a5e409fbafe28d4bc4c63dffe921dd77b8b`, and
  `5b3e3bb9d5376278764bb61420a14be7ec5843d7`.

## Layered evidence

| Layer | Result | Scope and limit |
|---|---|---|
| Schema/migration | **PASS, targeted 1/1** | The historical-upgrade owner ran enhanced positive P37→P38 fixture at test-source commit `cf47d1f471c30bb2d8abdb1849121abd0deb3456`; result-record commit `327298eb3d9473c12603b7bb3c0114cbe354d335`. It proves source `user_version=37`, P37 high-water 37, no old cancellation columns, 0038 target columns present, approval-row preservation, no-op repeat, 0033 composite FK and clean FK check. In P38 SQL the three destination cancellation fields are literal `NULL`; the earlier static missing-column hypothesis was incorrect and no production SQL change was made. This is an in-memory SQLite fixture, not deployment qualification. The consumed-legacy-Control negative fixture's exact failure reason still needs separate confirmation. |
| Static build/typecheck | **PASS after test fix** | Latest sequence: `pnpm build` PASS; `pnpm --filter @arbor/web build` PASS; `pnpm typecheck` PASS. An earlier `pnpm typecheck` found four TS18048 checks because the new process probes remained typed as possibly `undefined`; explicit missing-probe failures were added without changing timeout or pass oracle. |
| Browser build / targeted style | **PASS** | Web build transformed 255 modules; existing 557.88 kB chunk warning. Targeted Biome for both changed test files and `git diff --check` PASS. Static preflight confirmed `apps/web/dist/index.html`, `apps/single-workspace/dist/main.js`, and P4 child entry exist; no leftover Node/daemon/Vitest processes were present before or after the qualification runs. |
| Stop-vs-TTL SQLite store ordering | **PASS, 2/2** | One zero-retry Vitest invocation, 3.92 s total; each case 470/380 ms. Expiry-first leaves only `Expired/rev1`, one TTL event, then Stop no-op. Stop-first leaves only `Cancelled/rev1`, consumes the exact original Inbox entry, then expiry no-op. Retained DBs: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-p38-ttl-wins-stop-race-8OhtuW\approval.sqlite` and `C:\Users\ThinkPad\AppData\Local\Temp\arbor-p38-stop-wins-ttl-race-KpzuTK\approval.sqlite`. These exercise deterministic transaction orderings, not simultaneous cross-process Stop/expiry. |
| Claim commit → process crash before effect | **PASS, targeted 1/1 on corrected fixture** | The first post-edit run on `5b3e3bb` created a second Step-1 approval. Its retained DB showed exact Step-0 claim/consume then P4 `ExpectedFailure`, `MayHaveStarted`, `effectCount=0`, shell `exitCode=1` with empty stdout/stderr, plus Step-1 Pending approval. This was a fixture-command failure, not a P38 claim/replay result. The script was corrected at `a921ac0` by restoring the original `if (Test-Path proof.txt) { Add-Content; Move-Item }` effect scope and emitting the marker only after the successful move; a total Executable-approval-count=1 assertion was added. One zero-retry run on `a921ac0` passed 1/1 in 37.12 s. Assertions and read-only snapshot showed one approval for the Execution (`Consumed/rev2`, `consumed_by` exact same ToolInvocation), one invocation (`MayHaveStarted`/`Success`), same Step-0 ProviderTurn through action completion, one shell-log line, proof moved, target file present, and no daemon errors. Retained DB: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-0DOD8E\arbor-functional.db`; workspace: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-0DOD8E\workspace`; shell log: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-0DOD8E\workspace\p38-effects-P38-CLAIM-CRASH-078cd618.log`. |
| Effect → crash before settlement | **PASS, targeted 1/1 on corrected fixture** | One zero-retry run on `a921ac0` passed 1/1 in 38.98 s. At the probe, exact P38 approval was `Consumed/rev2`, tool invocation was `MayHaveStarted`/unsettled, and shell log contained one marker. After old process kill and two-daemon recovery, the exact same invocation settled `OutcomeUnknown` without replay; approval remained bound to the original consumer, exactly one Executable approval existed for the Execution, marker log remained one line, the proof file was moved, and daemons reported no errors. Read-only DB inspection confirmed the same invocation's `MayHaveStarted/OutcomeUnknown` settlement and the Step-0 same ProviderTurn in `SettlementProposed`. Retained DB: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-BtHjeW\arbor-functional.db`; workspace: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-BtHjeW\workspace`; shell log: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-BtHjeW\workspace\p38-effects-P38-EFFECT-CRASH-82c422a7.log`. |
| Initial process setup attempt | **NOT QUALIFICATION** | Before the Web build, the claim test timed out after 60 s in `startProductionFixture` health wait; it never reached approval/P4. `apps/web/dist` was absent and then built. No P4 child remained. Retained setup DB/WAL/SHM directory: `C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-4h7ljo`. Do not count this as a product failure or test retry. |
| Public API/browser/full release | **NOT RUN in this candidate** | Existing scoped v5 public/browser 5/5 remains earlier-candidate evidence only. Full `pnpm check`, full functional suite, public reject/expiry journeys and browser journey were not run in this closure branch. |

## P38 → P39 boundary

Accepted D0A/P4/06 RecoveryBindingV1 semantics require the eight approval keys
`approvalId`, `approvalSubject`, `approvalPreConsumeRevision`,
`approvalConsumedRevision`, `approvalExpiresAt`, `approvalTargetDigest`,
`approvalActionDigest`, and `approvalConsumedBy`. P38 produces a typed
`ExecutableApprovalConsumptionReceipt`; current Runtime drops the returned
receipt after reducing the claim result to `Claimed`. The accepted V1 key set
does not name a standalone `approvalDigest` property. More importantly, no
accepted mapping currently defines the target-only projection for
`approvalTargetDigest`, or whether regions/revisions feed
`targetResourceIdentityDigest`. The draft above records those exact gaps and
candidate choices without implementing or accepting them. P39 recovery-binding
assertions remain BLOCKED until the owner fixes both projections and P39
implementation is separately authorized.

## Remaining closure work

1. Confirm the legacy consumed-Control migration negative case fails for its
   intended check, not a generic setup error.
2. Run the public API/browser P38 layer and coordinated release gates only in
   root-authorized windows.
3. Resolve the V1 target-digest projection draft through manual governance, then
   wait for separate P39 implementation authorization before integrating the
   receipt fields into RecoveryBinding.

**Conclusion:** the positive ordered migration fixture, Stop/TTL store orderings,
and both P4 crash boundaries have targeted PASS evidence on the corrected
fixture. The process runs are per-case qualification only. Public/browser
qualification, the exact legacy-negative migration reason, and the manually
unresolved P39 target-digest projection remain open. P38 is therefore
**OPEN / NOT CLOSED**.
