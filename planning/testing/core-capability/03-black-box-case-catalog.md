# Black-Box Case Catalog

**Audit date:** 2026-09-27  
**Case-card status values:** `PASS`, `FAIL`, `BLOCKED_BY_IMPLEMENTATION`,
`BLOCKED_BY_DESIGN_GAP`, `NOT_RUN`

Each card records the same contract fields. “Allowed setup” is test-only
precondition state; the capability action under test must still start at the
specified external entry. A future qualification runner must persist the
actual request/response evidence and must not turn missing environment into a
skip/pass.

## B01 — Basic Human Conversation

- **User-visible requirement:** Submit one Human message; Arbor runs a real provider turn; one formal Assistant response becomes durable and is retrievable through the Web/API transcript.
- **Preconditions / input:** Root Workspace exists. Human submits one unique message.
- **Allowed setup:** Create Project/Workspace and provider configuration through their supported setup paths.
- **Forbidden shortcuts:** Insert the message directly into `human_messages`; accept a command receipt, ModelOutput trace, or scripted response as the Assistant reply.
- **Expected outcome / negative oracle:** Exactly one Human turn and one formal Assistant response are returned by transcript/API; retrying the same submission does not duplicate the Assistant response.
- **Provider / persistence / restart:** `REAL` required; real SQLite; restart not required.
- **Status / evidence:** `NOT_RUN`. Narrow live Human Input evidence exists at `planning/results/wave1-live-human-input-evidence.json`, but it bypasses external submission and transcript retrieval.

## B02 — Executable Tool Use

- **User-visible requirement:** A real model selects one visible, harmless executable tool, Runtime validates and executes it, the resulting observation returns to the model, and the final response uses it.
- **Preconditions / input:** Tool is registered with deterministic result and least privilege.
- **Allowed setup:** Seed an isolated project/resource and a safe fixture.
- **Forbidden shortcuts:** Invoke ToolRuntime directly as the capability oracle; use a recording provider to choose the tool; infer execution from a visible catalog entry.
- **Expected outcome / negative oracle:** Actual executor effect and returned observation are correlated to the invocation; the next model turn uses the observation; no control route or unauthorized capability bypass occurs.
- **Provider / persistence / restart:** `REAL` required; real ToolRuntime/executor and persistence; restart not required.
- **Status / evidence:** `NOT_RUN` (S01 qualification is not authorized by DID v1.18 Appendix C). P4 pipeline tests are L2 only.

## B03 — Control Action

- **User-visible requirement:** A real model requests a currently authorized control action; policy routes it to its owning Application boundary and a durable external/domain effect is observable.
- **Preconditions / input:** Only an already authorized action may be selected.
- **Allowed setup:** Existing domain state needed for the action.
- **Forbidden shortcuts:** Treat a constructed internal `AgentAction`, legacy `AgentDirective`, or handler invocation as the external success oracle; implement ControlToolRegistry as part of this audit.
- **Expected outcome / negative oracle:** Durable effect is visible from the external read face; wrong recipient, unauthorized actor, and duplicate input do not produce an extra effect.
- **Provider / persistence / restart:** `REAL` required; durable Application/persistence path; restart not required.
- **Status / evidence:** `BLOCKED_BY_IMPLEMENTATION`. DID v1.18 does not authorize ControlToolRegistry implementation or qualification.

## B04 — Multi-turn Memory / Cognitive Continuity

- **User-visible requirement:** Arbor remembers a fact from an earlier turn in the same conversation and does not disclose it in an unrelated session.
- **Preconditions / input:** Turn 1: “记住代码 BLUE-WHALE-17。” Turn 2: “我刚才让你记住的代码是什么？” A separate unrelated session asks the same recall question.
- **Allowed setup:** Persist Turn 1 and its formal Assistant response through the production path; then submit only Turn 2 to the same session and the recall question to the unrelated session.
- **Forbidden shortcuts:** Reinject Turn 1 text as Turn 2 fixture input; assert only that a planner ran or history rows exist; pass with a recording/fake provider.
- **Expected outcome / negative oracle:** Same-session real-model response includes exactly `BLUE-WHALE-17`; unrelated-session response/request has no access to that code.
- **Provider / persistence / restart:** `REAL` required; durable same-session history; restart not required for the minimum sentinel.
- **Status / evidence:** `NOT_RUN`. `p14-real-provider-conversation.test.ts` proves request composition with a canned fetch only; there is no unrelated-session negative oracle.

## B05 — Human Steer

- **User-visible requirement:** A running Agent receives a human steer, retains progress, changes its next cognition/action accordingly, avoids the prohibited mutation, and can resume autonomy afterward.
- **Preconditions / input:** Start a bounded task with one safe pending action. Submit: “停止修改代码，只分析原因”.
- **Allowed setup:** Isolated worktree/resource and a durable initial checkpoint.
- **Forbidden shortcuts:** Assert only `WorkSteered`, `stopRequestedAt`, an Inbox entry, or a prompt string.
- **Expected outcome / negative oracle:** Steer is durable; next real Provider request includes it; no prohibited mutation occurs; a later allowed continuation proceeds without losing earlier progress.
- **Provider / persistence / restart:** `REAL` required; durable steer/progress; restart not required.
- **Status / evidence:** `NOT_RUN`. P6 tests prove command semantics only.

## B06 — Parent / Child Communication

- **User-visible requirement:** Parent Query reaches the intended Child, Child Reply closes the correct correlation, Child Report reaches Parent, and Parent cognition consumes the durable message.
- **Preconditions / input:** Parent and Child exist with distinct identities and a known correlation.
- **Allowed setup:** Create the governed parent/child fixture and any required message body artifact.
- **Forbidden shortcuts:** Assert only a command receipt, bodyRef string, or Inbox count; use one Workspace for both roles.
- **Expected outcome / negative oracle:** Durable message/body, correct recipient and Inbox admission, correlation closure, and the next Parent real-model request contains the relevant message. Wrong recipient/correlation must not be admitted.
- **Provider / persistence / restart:** `REAL` required for Parent cognition; message/Inbox persistence required; restart not required.
- **Status / evidence:** `NOT_RUN`. P6 tests prove Application/Inbox/correlation integration; they do not prove BlobStore round-trip or Parent cognition.

## B07 — Responsibility Delegation

- **User-visible requirement:** Parent recognizes a stable responsibility, follows the frozen governance path, and a Child Workspace/Work is durably created with correct responsibility and authority boundaries.
- **Preconditions / input:** A task with one clearly independent long-lived responsibility and one case that should remain local.
- **Allowed setup:** Seed project policy and the authorized first-layer human decision.
- **Forbidden shortcuts:** Create a Child directly in the fixture; count a proposal as a durable Child; claim `ResponsibilityHandoff` is supported.
- **Expected outcome / negative oracle:** Real Parent proposal plus required governance decision produces exactly one Child and its intended Work; no unauthorized child or authority escalation.
- **Provider / persistence / restart:** `REAL` required for recognition/proposal; durable governance path; restart not required.
- **Status / evidence:** `BLOCKED_BY_IMPLEMENTATION` for the adopted model-facing control route. P6 formation tests are L2 workflow evidence.

## B08 — Specialist Delegation

- **User-visible requirement:** A temporary Specialist is bound to the current Execution, returns a result, and does not create a durable Responsibility or gain authority.
- **Preconditions / input:** One bounded specialist-only subtask.
- **Allowed setup:** A disposable Execution and scoped resource fixture.
- **Forbidden shortcuts:** Substitute a Child Workspace for Specialist; infer cleanup/lifetime from admission alone; assert internal AgentAction as success.
- **Expected outcome / negative oracle:** Result returns once to the caller; specialist lifecycle ends with its Execution; no durable responsibility or capability escalation is created.
- **Provider / persistence / restart:** `REAL` required for selection; durable Execution/session/Inbox; restart not required.
- **Status / evidence:** `BLOCKED_BY_IMPLEMENTATION` for the adopted model-facing control route. Existing tests establish admission/settlement seams only.

## B09 — Dependency / Deliverable

- **User-visible requirement:** Producer creates and delivers a bound deliverable; Consumer requests a match; the Runtime matcher alone decides whether the dependency is satisfied.
- **Preconditions / input:** One matching and one deliberately nonmatching ExpectedDeliverable.
- **Allowed setup:** Durable Producer/Consumer Work and their declared dependency.
- **Forbidden shortcuts:** Treat model intent, a `Deliver` event, or a fabricated satisfied state as matcher success; assume a new `RequestDependencyMatch` command where the frozen surface differs.
- **Expected outcome / negative oracle:** Only a structurally matching deliverable satisfies the dependency and wakes the correct Consumer; mismatch leaves it unsatisfied.
- **Provider / persistence / restart:** `REAL` required for Agent initiation; durable Deliverable/Dependency state; restart not required.
- **Status / evidence:** `NOT_RUN`. P7 integration proves matcher and transition mechanics, not agent initiation.

## B10 — Verification

- **User-visible requirement:** An independent verifier examines evidence for each criterion and records distinguishable Pass/Fail/Unknown without allowing Producer mutation.
- **Preconditions / input:** Frozen mission, evidence-bearing artifact/tool observations, and a separate verifier Execution.
- **Allowed setup:** Only evidence that exists through supported storage and observation paths.
- **Forbidden shortcuts:** Fabricate a ToolObservation reference, bypass a verifier, or use a summary string that has no durable target.
- **Expected outcome / negative oracle:** Evidence resolves to the selected source and criterion; verdict is supported; Producer cannot write verification state; conclusion is durably traceable.
- **Provider / persistence / restart:** `REAL` required for judgment; durable EvidenceRecord/summary association; restart not required.
- **Status / evidence:** `BLOCKED_BY_DESIGN_GAP`. Existing G-V2-2, G-V2-3, and G-V2-4 source audits remain open.

## B11 — Completion / Acceptance

- **User-visible requirement:** Producer's completion claim passes verification, authority, and revision gates; Parent/Human acceptance occurs where required; Work lifecycle changes only after the valid chain.
- **Preconditions / input:** One valid and three invalid variants: stale revision, non-PASS verification, unauthorized actor.
- **Allowed setup:** Durable Work, Verification, and acceptance policy.
- **Forbidden shortcuts:** Directly mark Work Completed or use a hand-built consumer event as proof of producer judgment.
- **Expected outcome / negative oracle:** Valid chain completes once; each negative case fails closed with no lifecycle mutation.
- **Provider / persistence / restart:** `REAL` required for the producer claim; durable Work/Verification/Acceptance; restart not required.
- **Status / evidence:** `NOT_RUN`. P8 command/acceptance tests are L2 and already cover several negative gates.

## B12 — Restart / Continuation

- **User-visible requirement:** After durable progress and a daemon restart, Arbor reconciles completed/unknown effects and continues with the correct frontier/context without blindly replaying side effects.
- **Preconditions / input:** Stop mid-task after one known completed effect and one pending safe step; restart the daemon.
- **Allowed setup:** Disposable SQLite database and safe tool fixture; explicit process boundary.
- **Forbidden shortcuts:** Reopen a database and call it cognitive continuity; use a fake provider as evidence that the resumed model knows the frontier.
- **Expected outcome / negative oracle:** No duplicate completed effect; recovered real Provider request uses the correct outstanding step and prior relevant context.
- **Provider / persistence / restart:** `REAL` required; persistent store and actual daemon restart required.
- **Status / evidence:** `NOT_RUN`. P5/P9 prove persistence/recovery mechanics, not cognitive continuation.

## B13 — Failure Recovery

- **User-visible requirement:** Provider/tool/argument/stale-action/retry failures are visible, bounded, and recover without silent success or duplicated side effects.
- **Preconditions / input:** One fault per run: transient provider failure, tool failure, invalid arguments, stale action, duplicate command/retry.
- **Allowed setup:** Deterministic fault injection for infrastructure failures; a real provider for behavior-dependent judgment.
- **Forbidden shortcuts:** Swallow an error, count retry as success, or replay an ambiguous non-idempotent effect.
- **Expected outcome / negative oracle:** Correct durable status/observation is returned; no duplicate side effect; invalid/stale operations fail closed.
- **Provider / persistence / restart:** `REAL` for model-visible interpretation; persistence required; restart only for crash/replay variants.
- **Status / evidence:** `NOT_RUN`. P9 supplies strong L2 recovery evidence but not the complete external/user-visible oracle.

## B14 — Web / Product Projection

- **User-visible requirement:** One submitted message yields one visible Human turn, one formal Assistant response, and no internal ModelOutput; older-history loading prepends the correct earlier range without replacing the current interval.
- **Preconditions / input:** Root conversation with enough durable turns to cross a page boundary.
- **Allowed setup:** Real server/composition and isolated database; external provider for the generated Assistant response.
- **Forbidden shortcuts:** Component render snapshots alone; synthetic `ModelOutput` exposed as Assistant; replacing instead of merging older pages.
- **Expected outcome / negative oracle:** Browser/API transcript shows correct Human/Assistant pairs once, hides ModelOutput, and preserves chronological order across pagination.
- **Provider / persistence / restart:** `REAL` required for generated reply; durable transcript required; restart not required.
- **Status / evidence:** `NOT_RUN`. Existing P13 HTTP and P14 projection/UI tests cover separate seams, not this whole scenario.
