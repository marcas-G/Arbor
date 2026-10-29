# AH7 / AH10 / AH14 / AH15–AH19 Recovery Matrix Audit

Date: 2026-10-12  
Audit baseline: `0f277366f15ef7f10e36dee6b6c536c5785d4c13`  
Method: static source/result review only. No daemon, Vitest, Playwright, or
repository-wide gate was started for this audit.

## Scope and authority

This is a scoped recovery-matrix audit, not AH-number or release closure. It
uses the frozen P9 `02` / `07` contracts, SCRC-008 phase/result records, the
P36 wave and integrated qualification records, the named AH qualification
records, and the current task instruction that P39 implementation is not
authorized. No `docs/design/**` file was changed.

The P36 integrated record reports `pnpm check` and `pnpm test:functional`
passing at tested code `6ee3ccd9248defae439e57f01cc4b339cc32d641`. Its
independent review is Blocking=0 but explicitly did not reproduce either
runner. That evidence is not silently extended to other SHAs or to closure of
an AH module.

## Module matrix

| Module | Crash/effect boundary and required durable truth | Evidence present at audit | Remaining disposition |
|---|---|---|---|
| AH7 | Action intent; P4 intent; effect admission; known/unknown external effect; P4 settlement; sourced ToolResult/Observation; action state and Step cursor. Each commit needs before/after recovery evidence, exact invocation/callRef identity, one effect, and no stale-generation write. | P36 Wave 2 reports no-approval Store/Denied/Interrupted, effect-admission takeover, stale settlement fence, P4 settlement, and P3 result/Observation/action/cursor cases. The seven-case `agent-action-ah7-pending-intent` process matrix brackets intent, settlement and action-result transactions; its assertions bind the unique callRef-paired ToolResult to the Observation source. P36's full functional run reports the selected AH7–AH19 cases passed. On v19, two full-gate attempts failed the non-skipped two-process barrier case at `Success filtered=[]`; Provider group is reported green. | **OPEN / PARTIAL; owner decision required.** AH7-DG-01 settled non-Success replay lacks durable bounded Observation evidence; its proposal is not accepted. AH7-DG-02 active Reconcilable reality reconciliation changes tool semantics and is not accepted. Production Executable `InvocationApproval` handoff is outside P36 Wave 2 and intersects P38. Both current child processes reuse one manually seeded worker/incarnation/generation tuple; this does not exercise two P2-acquired holders. The earlier `6073ed9` RED is distinct: unleased runtime results were A=Success/B=OutcomeUnknown, one effect occurred, and durable settlement became OutcomeUnknown. The two later v19 full-gate failures establish only `Success filtered=[]`; they lack raw A/B results and final P4 rows. Five bounded isolated reruns passed without firing the failure-only diagnostic; this does not resolve the full-gate reds. |
| AH10 | For each pinned LogicalAction across lease generations: old `FencingRejected` receipt before/after commit; old Committed receipt with Action still Pending before Observation; exact old receipt/canonical effect binding; one new effect maximum; same ProviderTurn/callRef and no provider re-inference. | Handler and real-process records cover AssignWork (including separately accepted direct-child target binding/Attention), ProduceDeliverable, DeclareDependency, AcceptResult, SendMessage and SelectCurrentWork, with multiple receipt transaction sides and Committed-but-Pending recovery. The direct-child binding package reports 12/12 scoped cases and P10 materialization/rebuild 9/9. | **OPEN / PARTIAL.** `Deliver` can still write through the old generation; its review says the fencing/receipt owner choice is not accepted. Verification evidence replay (`recordedAt` fingerprint) and P8 criterion snapshot are governance-blocked. Submitted SelectCurrentWork binding mismatch has a pending test whose observed terminalization leaves a settled Failed Execution with an ActionsInProgress/Pending orphan; failure semantics need owner decision. P39 RecoveryBinding-dependent changes are blocked by current authorization and must be coordinated before touching overlapping paths. |
| AH14 | Legacy adoption transaction before/after; unique evidence set; repeat adoption is identical; insufficient/conflicting action evidence produces durable, public Attention without Provider/action replay. | Positive equivalent legacy fixture is generated through the real daemon and killed on both sides of evidence upgrade / Step transition; repeat restart converges to one sourced answer and one public response. | **OPEN / PARTIAL.** The ambiguous legacy-action case remains a pending RED: public Attention is empty. AH14-DG-01 readiness review says the owner, severity, durable identity, transaction/visibility boundary and P9/P10 contract landing are not fixed. No implementation is authorized from the readiness review. |
| AH15 | Inbox source exists and is unconsumed; crash before promotion leaves no Session append; crash after promotion leaves exactly one sourced UserMessage and consumed row; no Provider request before promotion. | `AH15-inbox-input-promotion-crash` reports 2/2 real-process before/after commit. SCRC-008 also records source-key promotion/re-entry. | **Scoped PASS only.** Does not close all Inbox creation/admission or the AH15–AH19 matrix. |
| AH16 | P4 terminal settlement ↔ exact callRef-paired sourced ToolResult; before the append transaction neither result nor action progression is visible; after it, one result/source/action/cursor transition; restart must not re-run a settled effect. | There is no standalone AH16 result file. The existing AH7 seven-boundary process test has `AH7BeforeActionResultCommit` and `AH7AfterActionResultCommit`, verifies exact `callRef`, `observationRef`, `source_ref`, unique ToolResult and action state, and was included in the P36 reported full functional suite. SCRC-004/008 report the typed timeline contract and unit/recovery coverage. | **Existing cross-module coverage candidate; label as AH16-mapped evidence, not independent AH16 closure.** A focused standalone process rerun is prohibited during the current central gate; review source mapping after it releases. |
| AH17 | Successful compaction receipt ↔ atomic CompactionCheckpoint + ContextEpoch commit; kill before means epoch/checkpoint unchanged, after means one checkpoint/epoch advance; reuse same receipt on recovery. | `AH17-checkpoint-epoch-crash` reports real-process Summary before/after 2/2, exact epoch/checkpoint and ordinal-0 identity. Native checkpoint/recovery has scoped AH19 process coverage. | **Scoped PASS.** Summary boundary is explicit; do not call the entire cross-profile AH17 matrix closed from Summary alone. |
| AH18 | Terminal ContextLimit Attempt/Turn; ordinal-0 Inference/OverflowCompaction links; pinned Summary Turn/Manifest/Attempt; checkpoint/epoch; one OverflowReplacement; a second overflow terminalizes without a second chain. | `AH18-overflow-linked-compaction-resume` reports 12/12 real-process cases spanning failTurn, link commit, Summary Turn/Manifest, InProgress/RetryableFailure Attempt, Summary checkpoint and second overflow. Negative manifest/epoch cases fail closed. | **Scoped PASS only.** Does not close every P9/SCRC failure point or infer AH15–AH19 closure. |
| AH19 | ProviderNative continuation is reusable only under matching complete binding and exact source Step/turn/checkpoint; mismatch rebuilds portable context before exposing an opaque ref; malformed identity/hash/epoch/frontier fails closed. | Foundation plus overflow-linked match/mismatch and ordinary Work source-Step recovery records. Ordinary source recovery reports 31/31 scoped process cases; ProviderNative result covers matching-binding and changed-binding rebase, terminal response and corrupted source evidence. P36 full suite reports selected AH19 cases passed. | **OPEN.** Remaining recorded gaps include duplicate Native manifests at one Session/epoch (no real-process negative), half-null portable frontier (decoder-only negative), ConversationResponse cross-Episode checkpoint-owner semantics, and pre-checkpoint Work history beyond the 64-entry window. Any dependency on P39 RecoveryBinding is blocked; no recovery-source rewrite should be made before coordination. |

## Governance and integration gates

- AH7-DG-01, AH7-DG-02, AH7/P4 concurrent-settlement-owner, AH10 Deliver
  generation fencing, AH10 verification-evidence/snapshot, AH10 submitted
  decision-mismatch terminalization, and AH14-DG-01 have not been shown as
  accepted governance packages in the reviewed baseline. Preserve their
  pending REDs as evidence; do not implement semantic choices from them.
- AH7-DG-03 has an accepted owner amendment. P36 Wave 2 qualifies the listed
  no-approval route only. The production-approved Executable
  `InvocationApproval` route was explicitly excluded and overlaps P38; that
  exclusion remains a hard limit here.
- Direct-child AssignWork target binding is separately accepted, authorized,
  and scoped-implemented. That narrow authorization does not authorize other
  AH10 actions or AH10 closure. P39 RecoveryBinding implementation remains
  unauthorized per current task direction; dependent work must wait.
- P37 L6's record is a source/probe checkpoint with qualification not run.
  P38 has scoped public/browser approval PASS, not full phase closure. P40 and
  P41 are not to be treated as implementation authority for overlapping AH
  recovery paths. The central full-gate window has since released. This audit's
  initial matrix review launched no runner; the later bounded AH7-only
  diagnostic stress ran after explicit release and is recorded below.

## Module disposition

No production edit is made in this audit batch. The current open rows either
require a manual governance decision, depend on the unauthorized P39
RecoveryBinding, overlap P37/P38/P40/P41 ownership, or require process-level
qualification which the central gate currently reserves. AH7's full-gate red
candidate needs a P4/AH7 owner disposition; its isolated 5/5 rerun did not
reproduce the failure or produce the diagnostic snapshot. AH16 is identified
as a likely already-covered shared process boundary and should be reconciled
against the existing test source and qualification SHA after the gate, rather
than duplicated or promoted by assertion alone.

## AH7 same-holder race — fixed disposition options

The current failing child case has complete fence-shaped data but manually
seeds the lease row and starts two independent processes with the identical
`(executionId, workerId, workerIncarnationId, generation=0)` tuple. It does not
call P2 `LeaseService.acquire`, `runExecution`, or the production serial
AgentLoop action journal. P2 `03` defines the incarnation as process identity,
requires lease acquisition before drive, and authoritatively fences stale
generations. P4 `01`/`06` makes `(executionId, invocationId)` the invocation
identity, marks `MayHaveStarted` before execution, forbids automatic replay for
ambiguous NonIdempotent effects, and requires every mutation to check the
current full fence. P9 `02` T4 allows `OutcomeUnknown` or remaining active / in
reconciliation when a NonIdempotent effect may have occurred. None of these
contracts explicitly promises that multiple concurrent `ToolRuntime.invoke`
callers sharing one cloned holder tuple must serialize into the first
executor's known Success.

The static production path is serialized: `runExecution` obtains the lease
before `driver.drive`, and `model-output-journal.ts` processes the decoded
action list sequentially. Thus this fixture alone does not establish a
production-reachable two-owner race. The current runtime branch still has a
possible same-holder component-level race: after one caller commits
`MayHaveStarted`, a second caller may attempt a terminal `OutcomeUnknown` under
the same still-valid tuple before the first caller settles. The central full
gate observed the `Success filtered=[]` failure; five no-retry focused runs
passed and did not trigger the added failure-only diagnostic, leaving the
interleaving unobserved in the bounded rerun.

| Option | Frozen-contract fit | Cost / boundary | Disposition |
|---|---|---|---|
| A — keep concurrent same-holder ToolRuntime callers supported; introduce invocation-level owner/wait so a non-owner cannot persist premature `OutcomeUnknown` | Preserves the current test's success oracle, but current P4 records only `NotAdmitted` / `MayHaveStarted` and the lease-holder tuple. A cross-process owner token, durable wait/recovery rule, or equivalent coordination is not specified by P4/P9. | Could require new durable owner evidence, migration, and crash behavior for owner death versus lease expiry. A process-local mutex alone cannot coordinate separate Runtime processes/connections. Same-process re-entry must be included explicitly. | **Do not implement yet.** Requires P4 owner/governor disposition if this concurrency is in scope; otherwise it invents durable semantics. |
| B — qualify a real P2 takeover with two distinct valid generation fences | Directly matches P2 `03`, P4 `06` current-fence mutation, and P9 `02` AH7-AP8/T4: after gen0's non-idempotent effect is uncertain and gen1 acquires, late gen0 settlement is `LeaseFencingRejected`; gen1 does not replay and may keep/record the existing `OutcomeUnknown` disposition. | Must use actual lease acquisition/takeover and preserve one external effect. The valid final truth need not be `Success`, because gen1 cannot know gen0's uncommitted result. A separate success-receipt replay case remains as existing evidence. | **Best P2/P9 qualification path.** It tests old-owner rejection and exact recovery semantics, not the cloned same-holder race. |
| C — split component, production-call, and P2-takeover qualification | Store-level CAS asserts one intent and one `NotAdmitted → MayHaveStarted` transition only; a separate single authorized production invocation proves one Executor call; a P2-valid two-generation process case proves fencing/recovery. None proves same-holder concurrent-call support. | P4/P2 owner must still decide whether same-holder overlap is supported. Until then, keep the current same-holder test in default discovery with its strict oracle; do not classify it unsupported, pending, or passing by implication. | **Proposed evidence split only.** It does not resolve or authorize changing the current default red test. |

### Bounded diagnostic rerun

After the central full-gate release, a failure-only test diagnostic was added.
It records both child outcomes/error tags/stages, the canonical invocation and
lease tuple in one SQLite query, and effect markers before the unchanged
success/uniqueness assertions. `pnpm build`, test typecheck, and Biome passed.
The selected barrier case then passed five serial no-retry runs (1/1 each).
No diagnostic fired, so no raw A/B race outcome or final invocation snapshot
was collected. These five focused passes are not evidence against the full
gate's intermittent failure and do not close AH7. No production code or
assertion was changed.

The store-level effect-admission CAS does not prove an Executor call:
`Admitted` is not a durable invocation-owner token. The P4/P2 owner must decide
whether overlapping same-holder calls are supported. Until that decision,
the current default test and strict `Success` oracle remain unchanged.

