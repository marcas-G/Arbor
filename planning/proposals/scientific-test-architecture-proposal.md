# Arbor scientific test architecture proposal

Date: 2026-10-14
Audit base: `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`
Scope: test architecture and runner proposal only. No design contract or product behavior changes.

## Decision sought

Adopt four execution tiers that preserve the existing contract inventory while moving combinatorial state coverage to deterministic SQLite tests and keeping a small, explicit set of OS-process crash and real-time lease sentinels.

The existing `pnpm test:functional` remains the unfiltered final functional gate: all 46 Vitest functional files (45 process + 1 packaged clean-checkout) and all 6 Playwright files. It must use fresh results, execute serially as today, stop on the first failed stage, and retain the current public-process/browser oracles. This proposal does not claim that the current 46 files all belong in fast tiers; it defines their destination and the work needed to relocate redundant permutations without deleting assertions.

## Audited baseline

- HEAD is the requested `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`; the worktree was clean at audit start.
- `vitest.functional.config.ts` includes `tests/capability/black-box/s1-s4-public-api.test.ts`, `tests/functional/process/**/*.functional.test.ts`, and `tests/functional/package/**/*.functional.test.ts`; process files count 45, package files count 1. The capability S1–S4 file is also in the configuration and should be explicitly counted in the manifest as a pre-existing additional file (the stated “46 Vitest” count refers to the 45+1 functional files). Before implementation, settle this inventory count in the manifest rather than silently omitting it.
- Playwright has exactly 6 files under `tests/functional/ui/`, with `workers: 1`, `retries: 0`, trace and screenshot on failure.
- Current `test:functional` builds the root and Web production artifacts, then runs the complete functional Vitest config and Playwright config. `test:functional:process` and `:ui` are separate invocations and each repeats builds. `check:release` runs `check` plus `test:functional`.
- `tests/functional/` presently mixes public journeys, crash qualification, deterministic integration material, infrastructure qualification, pending design-gap evidence, and long recovery scenarios. One tier must not confer another tier's evidence claim.
- Existing process results have been very slow and variable: the recorded full functional run on `3ffb17a` took 1501.85 seconds for Vitest and 44.1 seconds for Playwright. The F20 clean-checkout case alone has recorded 44–66 seconds. The dense SSE P9 case takes about 10.7 seconds in isolation. These are measured anchors, not promises for the audited HEAD.

### Inventory count correction

The user-specified “46 Vitest” count appears to mean 45 process files plus the package clean-checkout file. The actual config also includes `tests/capability/black-box/s1-s4-public-api.test.ts`, making the configured Vitest inventory 47 files if that path is present and runnable. The manifest must enumerate it and report counts from the manifest/config consistency check. Do not drop it to make the count equal 46. The matrix below lists all 46 files under `tests/functional` plus the S1–S4 configured file as an additional row.

## Four tiers and evidence boundary

| Tier | Proposed command | Contents | Evidence it may claim |
|---|---|---|---|
| L1 Quick | `pnpm test:quick` | TypeScript build/type checks, architecture contracts, fast focused module suites, web type check; no browser, live provider, lease wait, or daemon crash | Types, architecture rules, module contracts |
| L2 Smoke | `pnpm test:smoke` | L1 plus deterministic SQLite state-machine/transaction tests; injected fixed Clock and ID source; public deterministic API smoke may be retained where it is already fast | Transition tables, receipts, replay, rollback, consumer offsets, restart-from-DB behavior in one process; not OS crash evidence |
| L3 Crash | `pnpm test:crash` | L1+L2 plus named real-daemon crash/restart and real-time lease sentinels in a fresh database; no UI or real model | Actual process death, same-database restart, OS/SQLite lock behavior, real cross-process lease timing |
| L4 Release | `pnpm test:release` and existing `pnpm test:functional` | Full `pnpm check`, full 46/47 functional Vitest inventory, all 6 browser files, package/clean-clone journey, and separately gated live-provider qualification when release policy requires provider credentials | Release candidate validation; provider-specific report separately records live model/deployment details |

`pnpm test:functional` remains the final deterministic functional command and must never become a changed-file subset. `test:release` is the broader release entrypoint. Do not make live-provider qualification an implicit side effect of `test:functional`; expose it as a named L4 step (`pnpm test:capability:real`) with its existing credential/deployment prerequisites and explicit evidence artifact.

## Exact coverage matrix: all functional Vitest files

The `L2 target` column identifies the deterministic contract that replaces parameter duplication. A file marked `L3 sentinel` retains its named OS-process case(s), not every action/tuple permutation. The full release command continues to run the complete current files unchanged until an equivalent L2 replacement is implemented and reviewed.

| File | Core case / contract to preserve | Tier assignment |
|---|---|---|
| `agent-action-ah7-p4-store-process-crash.functional.test.ts` | P4 store claim/Denied/Interrupted transaction outcomes across independent processes | L2: all store result/rollback variants; L3: one representative claim commit before/after process-death sentinel |
| `agent-action-ah7-pending-intent.functional.test.ts` | P4 intent and AgentLoop action identity replay at pending-intent boundary | L2: boundary × action/result matrix; L3: one committed intent then kill/restart |
| `agent-action-ah7-reconcilable.functional.test.ts` | Reconcilable external-effect uncertainty recovery | L2: deterministic reconciliation state transitions and fail-closed cases; L3: one effect-before-settlement sentinel only after an authorized reality-proof path exists; otherwise retain current evidence as open, not PASS |
| `agent-loop-ah10-assign-work-takeover.functional.test.ts` | old generation committed AssignWork receipt, Action still Pending | L2: receipt state × generation × action result matrix; L3: one current-Workspace AssignWork takeover representative |
| `agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts` | direct-child placement/manifest/receipt binding | L2: all binding and rejection permutations; L3: one direct-child public-process sentinel if still required by the phase contract |
| `agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts` | direct-child receipt takeover before/after commit | L2: before/after and Committed/Pending combinations; L3: one representative receipt takeover; preserve this distinct direct-child authority case |
| `agent-loop-ah10-generation-takeover.functional.test.ts` | ProduceDeliverable, DeclareDependency, AcceptResult old-generation receipt recovery | L2: full action × before/after × receipt/action-state matrix; L3: one non-idempotent canonical effect and one committed-receipt recovery sentinel |
| `agent-loop-ah10-select-current-work-takeover.functional.test.ts` | DecisionEpisode receipt takeover and redispatch | L2: decision receipt, execution/step/action terminalization table; L3: one DecisionEpisode process takeover sentinel |
| `agent-loop-ah10-send-message-takeover.functional.test.ts` | Query/Reply/DecisionRequest ordering and takeover | L2: message kind × receipt boundary × Inbox/correlation/offset outcomes; L3: one Query receipt takeover and one post-consumption Reply or DecisionRequest settlement sentinel |
| `agent-loop-ah11-step-effects-crash.functional.test.ts` | Observation append → StepEffectsCommitted | L2: transaction visibility, cursor, action/effect/observation uniqueness; L3: one before-commit and one after-commit process kill for this atomic boundary |
| `agent-loop-ah12-settlement-command-crash.functional.test.ts` | SettlementProposed → SettleExecution / Verification recovery | L2: accepted/rejected/duplicate settlement matrix; L3: one pre-commit and one post-commit daemon restart |
| `agent-loop-ah13-conversation-convergence-crash.functional.test.ts` | settled Execution → ResponseJob/Attempt convergence | L2: response/attempt terminal state and idempotent convergence table; L3: one pre/post commit pair, one public reply and one provider-call assertion |
| `agent-loop-ah14-legacy-adoption-crash.functional.test.ts` | positive equivalent legacy evidence adoption | L2: equivalent/ambiguous/missing evidence disposition; L3: one positive adoption pre/post commit pair. Keep AH14-DG-01 negative case excluded and visibly pending until governed |
| `agent-loop-ah7-b-effect-before-settlement.functional.test.ts` | A Applied, B Idempotent external effect happened, B settlement absent | L2: B outcome × cursor/receipt/effect matrix; L3: one representative effect-before-settlement process kill |
| `agent-loop-ah7-b-intent-before-effect.functional.test.ts` | A Applied, B committed P4 intent before effect | L2: intent/effect/settlement recovery table; L3: one intent-before-effect restart sentinel (distinct persistent boundary from effect-before-settlement) |
| `agent-loop-ah7-two-action-interleaving.functional.test.ts` | A then B cursor 0→1→2, one effect/result/observation each | L2: action pair × outcome × cursor progression; L3: retain one ordinary A→B two-action restart scenario only if not already covered by the B-intent/effect sentinel |
| `agent-loop-ah8-action-b-stale-after-restart.functional.test.ts` | Steer changes ControlBasis after A; stale B skipped | L2: stale/current basis and skip successor table; L3: one stale-basis across-restart sentinel |
| `agent-loop-ah9-terminal-action-recovery.functional.test.ts` | terminal action skips remaining actions and persists settlement proposal atomically | L2: terminal class × remaining-action count × receipt state; L3: one transaction pre/post process boundary pair |
| `ah10-p10-attention-materialization.functional.test.ts` | P10 Attention projection, rollback, retained-fact rebuild, isolation, reopen and real daemon discovery | L2: projector/offset/retention/rebuild matrix; L3: one representative P10 public view across restart and one kill around the atomic snapshot/offset boundary |
| `ah15-inbox-input-promotion-crash.functional.test.ts` | Inbox promotion and consumption, same MessageId after process loss | L2: promotion/append/consume transaction variants; L3: one Inbox promotion pre/post commit pair |
| `ah17-checkpoint-epoch-crash.functional.test.ts` | Summary checkpoint and ContextEpoch atomic persistence | L2: checkpoint/epoch binding and replay matrix; L3: one pre/post commit pair |
| `ah18-overflow-linked-compaction-resume.functional.test.ts` | Overflow link and Summary turn recovery, terminal failure, orphan/mismatch fail-closed cases | L2: all deterministic receipt/manifest/epoch/terminal permutations; L3: representative overflow-link and terminal-attempt crash sentinels per distinct transaction. Preserve open AH18 missing/unsettled Summary Turn and repeated-overflow gaps as gaps |
| `ah19-provider-native-binding-recovery.functional.test.ts` | ProviderNative binding match/mismatch, portable rebuild, exact predecessor/successor, overflow and pinned output | L2: binding/manifest/epoch/hash/predecessor corruption matrix; L3: minimal same-binding success and changed-binding portable rebase process sentinels. Keep open AH19 profiles visibly unqualified |
| `command-input-validation.functional.test.ts` | F23 malformed typed MessageId/AcceptanceId and historical receipt rules | L2: codec and receipt tuple table; L3: retain public `/commands` negative boundary because codec is external input; this remains pending governance evidence, not a successful contract assertion until F23 is resolved |
| `cross-work-delivery.functional.test.ts` | F19 produce/deliver then declare; exact Dependency satisfaction | L2: event order and exact artifact/ref/status transitions; L3: no required crash sentinel unless shared coordinator persistence changes |
| `cross-work-wake.functional.test.ts` | F19 declare first, sleep, later delivery wakes consumer exactly once | L2: consumer offset/wake/duplicate event table; L3: no required crash sentinel unless wake transaction changes |
| `f21-open3-activation-recovery.functional.test.ts` | P12 Gateway committed Pending intent, exclusive profile, missing path and Attention replay across restarts | L2: activation/retry/attention projection transitions; L3: one process restart of committed Pending intent, one restart of retained Attention replay |
| `f21-open3-p10-full-rebuild.functional.test.ts` | P10 Story L rebuild crash before/after snapshot-offset commit | L2: rebuild/rollback/offset table; L3: one pre-commit and one post-commit kill on the atomic boundary |
| `f23-receipt-tuple-ordering.functional.test.ts` | tuple mismatch before corrupt JSON decode; exact tuple malformed result/error fails closed | L2: tuple/result/error shape matrix; L3: none beyond `command-input-validation` external-boundary sentinel |
| `human-steer.functional.test.ts` | F07 revision-bound SteerWork reaches later Agent execution | L2: command revision/cursor/snapshot state table; L3: no crash sentinel required |
| `model-output-ah5-ah6.functional.test.ts` | sourced ModelOutput + OutputAccepted atomic commit, no duplicate output/provider call | L2: transaction atomicity and exact source uniqueness; L3: one pre/post commit crash pair for the shared atomic boundary |
| `organization.functional.test.ts` | F18 child proposal, exact approval, initial Work, PASS, Parent Acceptance | L2: formation/approval/result/acceptance transitions and event order; L3: one child result acceptance restart sentinel only if child and parent durable stores cross a process boundary |
| `p37-delivermessage-process-crash.functional.test.ts` | DeliverMessage receipt/Inbox drift, consumed evidence, old-gen observation fencing | L2: receipt state × Inbox existence/consumption × event drift × generation matrix; L3: one pre/post commit takeover sentinel and one consumed/cleaned Inbox proof sentinel |
| `p38-control-approval-current-assign-work.functional.test.ts` | exact CAPA approval consumer CommandId, Work and receipt once | L2: exact grant/approval/action/command receipt join; L3: one approved current-Workspace assignment recovery sentinel |
| `p38-executable-approval-public.functional.test.ts` | public approve, reject/expire, same-step resume, duplicate prevention around effect | L2: approve/reject/expire × exact step × effect-before/after matrix; L3: one pre-effect and one post-non-idempotent-effect approval crash sentinel |
| `p39-maintenance-writer-exclusion.functional.test.ts` | OS-level mutual exclusion, opposite writer blocking, crashed daemon permit release | L2: lease/permit state and error table; L3: retain all three OS-process lock cases because the OS lock/VFS release is the contract under qualification |
| `p4-ah7-effect-admission-takeover.functional.test.ts` | generation fencing by side-effect class and boundary | L2: full side-effect class × boundary matrix with deterministic Clock and transactional effects; L3: one real old-generation effect-before-settlement takeover per distinct admission contract |
| `p4-ah7-live-lease-acquisition.functional.test.ts` | second live daemon cannot acquire/run same Execution | L2: fake-clock lease CAS and no-side-effect table; L3: one actual two-daemon live-lease rejection sentinel |
| `p4-ah7-tool-settlement-lease-fencing.functional.test.ts` | old generation fenced after non-idempotent effect and before settlement | L2: transaction/authority result matrix; L3: one actual old-owner process fence after effect |
| `p9-dense-sse-lease-renewal.functional.test.ts` | TTL/3 renewal under active SSE after >512 read/written/persisted frames; one Provider call | L2: deterministic renewal calculation, cancellation and deadline tables; L3: retain as a real-time sentinel; never substitute TestClock or lower frame/TTL requirements |
| `production-fixture-startup-cleanup.functional.test.ts` | cleanup after clone and provider startup failures | L2: fixture resource lifecycle/failure-injection matrix; L3: one spawn/terminate cleanup process check if process handles are involved |
| `provider-failure-ah4.functional.test.ts` | terminal 401 and exhausted repair recover without fake reply/re-inference | L2: terminal outcome × repair status × output receipt table; L3: one representative terminal provider-failure before/after settlement boundary pair; preserve the distinct repair-exhaustion state in L2 |
| `provider-success-ah1-ah3.functional.test.ts` | AH1/2 atomic success plus AH3 settled Turn → Step result | L2: atomic transaction and recovery state table; L3: one pre/post pair for AH1/2 atomic Success and one pair for the distinct AH3 Step handoff boundary |
| `rai-readmission-hold.functional.test.ts` | P37 mismatch ACK and RuntimeSafetyStop hold; ordinary stop without P9 fact | L2: ACK/stop/readmission fact combinations; L3: one restart proving same Work revision remains held. Keep `RAI-DG-01` state marked pending where policy requires |
| `recovery-verdicts.functional.test.ts` | F10 rejection, F11 retry, F12 Fail, F13 Unknown, F16 crash/provider completion, F17 pagination | L2: rejection/retry/verdict/pagination table; L3: one F16 after-wire crash sentinel; preserve F10–F13/F17 public API journeys in L4 |
| `clean-checkout.functional.test.ts` | F20 frozen install/build/start/public API from committed clean checkout | L4 only; package boundary is intentionally full-checkout validation |
| `tests/capability/black-box/s1-s4-public-api.test.ts` | S1–S4 user observable lifecycle coverage | L4 public API journey; fast smoke may run only if it is already deterministic and distinct from F01–F19, but must not be omitted from release manifest |

## Exact coverage matrix: all 6 browser files

| File | Core case / contract to preserve | Tier assignment |
|---|---|---|
| `approval-completion.spec.ts` | F14/F15 exact approval without IDs, PASS and user Acceptance | L4 browser; L2 state transitions may cover data matrix, but browser proof stays |
| `completed-work-visibility.spec.ts` | F22 completed Work page after Acceptance and hard restart; absent/foreign target 404 | L4 browser; L2 route/read projection and non-disclosing target matrix |
| `f21-project-resource.spec.ts` | F21 resource profile selection to evidence/Verification/Acceptance and forged refs rejected | L4 browser; because FT-DG-01 remains open, preserve failing/pending semantics and do not count as release PASS until governed |
| `p38-executable-approval-browser.spec.ts` | exact executable approval resolved in Queue and same action resumes | L4 browser; L2 exact approval binding matrix |
| `project-conversation.spec.ts` | project creation, chat and authoritative answer after daemon restart | L4 browser; L2 conversation/provider event transitions |
| `project-route-session.spec.ts` | foreign Workspace route rejected before DTO; direct load/refresh/picker/history remain project scoped | L4 browser; L2 routing/authorization result matrix |

### No coverage deletion rule

The manifest uses stable case IDs and has `preserves` links from every existing case to one or more new tier cases. A moved case is deleted from its old process file only after its L2 replacement passes against the same accepted assertions and the L3 sentinels still cover the relevant process property. If a case is unique to a public API/browser/provider/OS/process boundary, it remains there. Pending governance reproductions stay explicitly `pending`/`excluded-from-pass-count`, not recast as successful behavior.

## Move combinatorial branches to L2; keep process-specific sentinels at L3

### Move to deterministic L2

- Parameter products whose axes are values/state-machine branches: `before/after` around simulated transactions; result kinds; action kinds; receipt states; command identity; grant/approval targets; Inbox present/consumed/cleaned; correlation/offset combinations; manifest hash/epoch/predecessor variations; old/current generation; stale/current ControlBasis; replay/rebuild states; exact versus malformed IDs.
- AH10 action-by-action × old receipt boundary products (`AssignWork`, `DeclareDependency`, `AcceptResult`, `ProduceDeliverable`, `SendMessage`, `SelectCurrentWork`) after preserving an independent storage/Gateway state table for each action kind and tuple. These outcomes are mostly determined by exact receipt and state transitions. Keep at least one real process recovery sentinel across distinct handler families and one DecisionEpisode, because scheduler redispatch differs from WorkEpisode dispatch.
- AH7 action A/B and outcome permutations, cursor states, result identities, dedupe keys, idempotent versus non-idempotent classes, transaction rollback, and fake same-time/expiry decisions. Include approval and reconciliation as modeled inputs where the frozen contract defines them. Do not mark open AH7 governance paths as qualified.
- P38 Approve/Reject/Expire, exact binding and whether effect has happened; P37 receipt/Inbox permutations; P10 rebuild/consumer offset permutations; AH18/AH19 corruption/binding matrices.
- F10–F19 domain workflow branches. Their public journey intent remains in L4; L2 checks the exhaustive stable transition tables that are too expensive to repeat through real daemons.

### Keep as named L3 sentinels

- One OS process killed immediately before commit and one immediately after commit for each *distinct* durable transaction boundary class in AH1/2, AH3, AH4, AH5/6, AH7 intent/effect/observation, AH8 stale basis, AH9 terminal proposal, AH11, AH12, AH13, AH15, AH17 and P10 snapshot/offset. The before/after pair need only be run once per same atomic boundary; an action/value permutation does not create a new process boundary.
- At least one old-generation fencing takeover for each runtime route family that uses different dispatch/settlement plumbing: executable tool/P4, Work control receipt, SendMessage/Inbox handover, and scheduler DecisionEpisode. Choose the most discriminating case and keep the other tuples in L2.
- P39 all three OS writer/maintenance cases, because process ownership and SQLite VFS lock release cannot be simulated by a fake clock or transaction rollback.
- One actual two-daemon live-lease rejection sentinel and the P9 dense SSE/TTL/3 sentinel. See clock/TTL constraints below.
- F16 one crash after provider wire completion and restart against the same DB; F20 clean checkout; all six browser tests; live-provider qualification only in the separately named L4 live lane.

If a frozen P9/AH contract requires a particular two-sided process boundary that is not in the list above, add that unique boundary to the manifest and retain it. “Representative” means one representative per distinct transaction/runtime boundary, never one test for all unrelated boundaries.

## Manifest and runner design

Add `planning/testing/manifest.json` as the single checked inventory. Each entry has:

```json
{
  "id": "AH10.SendMessage.Query.receipt-before-commit",
  "path": "tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts",
  "case": "Query old-generation FencingRejected receipt before commit",
  "tier": "L2",
  "runner": "vitest-functional",
  "tags": ["ah10", "send-message", "receipt", "takeover"],
  "preserves": ["existing-case-id"],
  "status": "active",
  "estimatedSeconds": 2
}
```

Additional fields: `dependencies` (source/package/test helper paths), `requires` (`sqlite`, `daemon`, `browser`, `real-provider`, `clean-checkout`, `wall-clock-ttl`), `cache` (`eligible`/`never`), and `evidence` (result artifact name/pattern). Stable case ID is independent of filename and test title. `pending` cases are listed but never count as passes.

Add a small `scripts/testing/run-suite.mjs` and `scripts/testing/check-manifest.mjs`:

1. Validate every active manifest entry resolves to exactly one test path/case; validate every included Vitest/Playwright test file is listed. The configured S1–S4 file is included. Fail on omissions, duplicate IDs, invalid tier ordering, pending case included as passing, or a test title/path not represented in the manifest.
2. Resolve the requested tier to a deterministic ordered list. Run one command at a time and stop immediately at the first non-zero result. Capture command, HEAD/dirty state, OS, Node/pnpm versions, manifest digest, start/end time, selected case IDs, exit code and artifact links into `.test-results/<run-id>/summary.json` and human-readable Markdown.
3. `quick` executes L1; `smoke` executes L1 then L2; `crash` executes L1, L2, then L3; `release` executes L1→L4 and mandatory `pnpm test:functional`. Fail fast means later stages do not run after failure; always run cleanup in `finally` and preserve logs/traces.
4. Existing direct commands remain callable. `pnpm test:functional` invokes production builds once, verifies manifest consistency, then runs all functional Vitest files and all 6 UI files with retries zero and cache disabled. It does not delegate to changed-file selection.
5. Script names proposed in root `package.json`: `test:quick`, `test:smoke`, `test:crash`, `test:release`, and `test:manifest`. Preserve `test:functional`, `test:functional:process`, `test:functional:ui`, `test:capability:real`, `architecture`, and `check:release` behavior; they can call the runner after migration without changing coverage.

### Changed-file selection and result cache

- Compute changed paths from committed base and, for local runs, include staged, unstaged and untracked paths. If git state cannot be resolved or a path lacks a manifest dependency map, select the entire relevant tier.
- Mapping is many-to-many. A Domain/port/store/runtime change selects the direct L1 module tests, all L2 cases depending on the changed package, plus any L3 sentinels declared for that runtime route. A web/API/view change also selects the mapped browser cases. Migration/SQL/schema/bootstrap changes select every L2 case and every migration/clean-checkout case. Runner/config/manifest/helper changes select all tiers. Design changes select the mapped contract suite and trigger a manifest consistency review.
- A local cache may reuse only successful L1/L2 outputs and only when the full input fingerprint matches: HEAD/base diff, dirty/untracked digest, dependency graph, lockfile, Node and pnpm versions, OS/architecture, test config, manifest digest, runner digest, relevant environment names and generated schema-template identity. Never cache failures, L3 crash/TTL results, live-provider results, browser sessions, F20 clean checkout, or release outcomes.
- `pnpm test:functional`, `pnpm test:release`, and CI release jobs set `ARBOR_TEST_CACHE=off` and bypass selection. They run the manifest's complete release set, including unchanged files. A cache hit is reported as `reused`, never as a newly executed pass.
- Cache artifacts are local disposable acceleration only; the recorded result states exact source fingerprint and reused case IDs. No cache may turn skipped, pending or absent tests into passes.

## Clock port, Effect TestClock and real TTL

The audited code has two Arbor clock ports in `packages/ports/src/runtime.ts`: `ClockService.now()` returns a persisted ISO time through Effect, and `RuntimeClockService` separates epoch time from monotonic elapsed time. `packages/execution-runtime/src/execution-runtime.ts` currently sets `LEASE_TTL_MS = 30_000` and derives the renewal interval as TTL/3; the comment explicitly says the TTL duration is empirical and the cadence is the contract.

Use injected `Clock` and `RuntimeClock` layers in L2. Drive expiry, approval windows, retry deadlines, generation fencing, provider timeout and renewal-loop scheduling with deterministic epoch/monotonic clocks. Effect's installed `TestClock` (local dependency `effect@4.0.0-rc.115`) controls Effect sleeps and timers and can advance them without waiting. It does not automatically replace Arbor's two ports, Node `Date.now`, `performance.now`, SQLite's process-visible time, filesystem timestamps or a second process's clock. Compose it with explicit `Clock`/`RuntimeClock` test layers; use it only for Effect scheduling. Tests must assert both epoch and monotonic behavior where the production path consumes both.

Do not shorten `LEASE_TTL_MS`, pass a reduced production TTL, alter an expiry row to claim natural expiry, or share one in-process TestClock as evidence of cross-process expiry. Those can test local CAS/state transitions at L2, but they do not qualify a real TTL boundary. A cross-process TTL qualification runs the production TTL policy with real clocks and independent daemons. For the current 30-second implementation, natural expiry needs at least the actual lease lifetime plus startup/recovery margin (plan roughly 35–50 seconds); the P9 TTL/3 sentinel must observe a real committed renewal during an active stream after the full frame/persistence thresholds. If the empirical duration changes, do not change the test's expected timing by editing production code; read the production setting and preserve the frozen TTL/3 relation, then record the measured interval.

Keep L2 lease tests fast by using the Clock port and direct fake-clock `advance` against the production renewal coordinator/SQLite adapter, without real `sleep`. Keep L3 tests event-gated (probe/IPC/SQLite state), never fixed-sleep guesses. L3's lease claim must be based on wall-clock timestamps from both independent processes and the canonical DB row. The test can use a bounded timeout for failure, but cannot assert success just because that timeout elapsed.

## Expected duration (initial budget; measure during implementation)

These ranges are engineering targets, not evidence from this audit:

| Run | Target | Basis |
|---|---:|---|
| L1 `test:quick` | 30–90 seconds | build/type/architecture subset; reuse existing project checks without adding new work |
| L2 `test:smoke` | 1–3 minutes | deterministic SQLite suites after moving expensive daemon permutations |
| L3 `test:crash` | 3–8 minutes normally; 8–12 minutes on Windows | selected process boundary sentinels plus one natural-TTL/P9 case; all waits event-driven except the real TTL interval |
| L4 `test:functional` | initially about 20–35 minutes, variable | audited precedent is 1501.85 seconds Vitest + 44.1 seconds browser; target reduction depends on successfully replaced duplicates and must not be achieved by dropping unique cases |
| L4 release with full `pnpm check` + functional + live provider | about 30–60+ minutes plus provider latency | exact runtime depends on architecture/core/Web suites, clean install and remote provider |

Track median/p95 per manifest case and per tier for 20 successful runs. Do not set a short CI timeout that truncates a legitimate TTL witness; configure per-suite upper bounds from measured p95 plus operating-system recovery margin.

## Phased implementation order

1. **Inventory and runner contract (no test deletion).** Add manifest with all 47 configured Vitest paths and 6 UI paths, stable IDs for cases, current status and source evidence. Add validator and report only; compare actual config discovery with manifest. Resolve 46-versus-47 count discrepancy explicitly.
2. **L1 command and baseline timings.** Add `test:quick`, selecting only existing fast module/type/architecture suites. Establish environment fingerprint and fail-fast report. Do not change `test:functional`.
3. **Clock/test harness extraction.** Add test-only `Clock` and `RuntimeClock` layers and deterministic SQLite state-machine harness. Prove fake epoch and monotonic advance independently; add cases for current slow `wait`/expiry paths as in-scope module tests.
4. **Migrate matrix permutations to L2.** Start AH10 receipts, AH7 action/status combinations, P37 receipt/Inbox states, P38 approval outcomes, P10 rebuild offsets, AH18/AH19 binding matrices. Keep all existing L3 files running until same-case L2 assertions pass and are linked through `preserves`.
5. **Establish minimal L3 sentinels.** Select exact pre/post pairs by persisted transaction boundary, plus P39 OS writer tests, one live-lease rejection, P9 dense SSE/TTL/3, F16, and clean-checkout only in release. Use real daemon builds, independent process clocks and event gates. Run the reduced L3 suite repeatedly to qualify flake rates.
6. **Wire changed-file selection and safe cache.** Enable only for local `quick`/`smoke`; first run in report-only mode to compare selected cases with full tiers. Enable reuse after fingerprint and dependency-map mutation tests are reviewed. Crash/release remain cache-off.
7. **Release integration and closure review.** `test:functional` still performs full production build, full configured Vitest and all six Playwright files. `test:release` chains full check, crash sentinels, full functional suite and explicitly configured live-provider evidence. Review manifest links against F01–F23, S1–S4, AH1–AH19/SCRC evidence and open governance queue; publish timings and exact executed/reused/skipped/pending counts.

## Acceptance criteria for implementation

- Manifest/config file counts reconcile and enumerate every configured suite; current 46 functional Vitest + 1 configured S1–S4 + 6 UI are visible.
- Every legacy core case has at least one `preserves` mapping. No pending design-gap reproduction moves into a passing count.
- L2 covers every moved branch tuple and runs on SQLite without a real daemon process or real 30-second wait.
- L3 contains one pre/post process sentinel for each unique persistence boundary class plus all necessary cross-process/OS/real-TTL sentinels. Evidence records same DB path, PIDs, boundary reached, generation, provider/action counts and final public state.
- Real TTL proof uses unchanged production duration/cadence and wall clocks; no TestClock shortcut or shortened TTL is described as process qualification.
- Failure stops the selected tier immediately, teardown runs, diagnostics persist, and no retry converts a failure to a pass.
- Local cache matches the full fingerprint and only reuses L1/L2. Release and `pnpm test:functional` prove they bypass cache and selection.
- `pnpm test:functional` still runs all functional Vitest and all browser files even when no relevant source file changed.
- Measured tier duration and p95 are in the report; no runtime reduction is claimed until equal-coverage evidence supports it.

## Audit limitations

This was a read-only source/design/script audit at the specified HEAD. No test was run. The test inventory count discrepancy above is grounded in the committed Vitest include globs and filesystem file counts. Tier durations other than cited historical results are targets. Existing case IDs and exact assertion signatures should be harvested by the manifest validator during phase 1; this proposal's core-case labels are a routing map, not a replacement for the original test oracles.
