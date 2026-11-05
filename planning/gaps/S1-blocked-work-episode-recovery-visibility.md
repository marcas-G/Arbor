# S1 Blocked Work Episode Recovery Visibility — Design Gap

**Status:** OPEN — candidate contract only; no `docs/design/**` changes.

## Failure evidence

Isolated first-release instance only (`http://127.0.0.1:8791`; never live
8787). The independently verified diagnostic snapshot is
`%APPDATA%\ArborFirstRelease\isolated-acceptance-e8d90756-20261012\evidence\diagnostic-live-snapshot-20261012.db`
(integrity check `ok`, SHA-256
`8df0fe18fc348adbb1f5413afa4fc3610fae5ffcc984a482cf0bd17ebf027b0c`).
No database was written or daemon stopped.

Identity: Project `prj_01a12eea-1eff-73ca-afe1-d9f97fd142d0`, root Workspace
`ws_01a12eea-1eff-74e1-8112-756f5eb0636c`, Work
`wrk_27ad1efe-50c8-7b1e-88b4-cf5a4eb93014` revision 0. The latest WorkEpisode
is `exe_57a24601-7b20-7026-8c90-0f089bef3abf`: ProviderTurn succeeded with
`finishReason=ToolCall`; patch and shell each received durable
`TerminalRejected`/`ControlledInterruption(ExecutableToolInvocationRejected)`;
the model then marked Plan steps Blocked and yielded through `wait` with a
Manual condition. The Episode settled normally as `Completed(Yielded)`. Neither
rejected action produced a write effect.

Read-only public reads at the same isolated instance returned:

- `POST /views/responsibility-tree`: Workspace `waiting-blocked`, Current Work
  Open revision 0, no active execution, subtree Attention counts both zero.
- `POST /views/current-work`: that Open Work, no active execution.
- `POST /views/attention`: `rows: []`.
- `POST /views/work-detail`: canonical Work goal/reason/expectation and Open
  lifecycle only; no episode, wait reason, rejected action, Verification or
  Evidence.
- `POST /views/workspace-detail`: generic blocked Current Work and no active
  execution summary; the audit timeline is empty.
- `POST /views/transcript` (100 newest rows): it includes ModelOutput and
  Observation rows only as `session-entry:<session>:<sequence>` refs and
  timestamps. It does not include their payloads or the WorkEpisode's typed
  action failure / wait explanation.

The public tree therefore signals that something is blocked, but gives no
explanation or recovery handle. Re-reading does not supply the missing reason.

## Frozen-contract reading

- EGP-3/4 (`docs/design/02-system-design.md`): Work is the durable Goal;
  Execution advances it; Plan is optional model-maintained cognition and has no
  completion authority. The model's Plan `Blocked` rows cannot become canonical
  status or Attention by themselves.
- DID §6A.6 and §8.16 (`docs/design/03-detailed-implementation-design.md`):
  `Completed(Yielded{..., waitFor: Manual})` is a valid stable Episode result;
  `Execution Completed != Work Completed`. A Work remains Open until the
  independent Verification → Acceptance → CompleteWork chain. With no claim,
  no Verification is correct. The wait registration is durable and does not
  poll; `Manual` requires an external/manual wake.
- S1 v1.3 §§7, 9 and S3 v1.3 §§9–10 (`docs/design/01-scenarios.md`): Agent
  should continue autonomously; when an operation cannot be recovered locally,
  it enters the blocked/upward-help path; the user should be able to see what is
  blocked. This incident is a root Workspace, so no Parent exists to receive
  that escalation.
- SD §12.3 and P10 `02` §1 / `planning/tasks/P10-004.md`: Attention is derived
  from the enumerated sources. A WorkEpisode that yields on Manual after a
  terminal action rejection is not one of them. A Manual wait alone is not
  specified as Attention. The current empty Attention result is consistent
  with this source list.
- MAC `02-action-approval-error-boundary.md` §4 distinguishes terminal
  operational failure/attention from retryable interruption, but does not say
  when a model-consumed `TerminalRejected` becomes an unresolved Work blocker,
  what public record represents it, or how that record clears. S1/S3 establish
  the observable need to escalate, but do not define a domain/projection shape.
- CDRC-10's explicit user-visible/resumable retry and attention lifecycle is
  owned by `ConversationResponseJob` (SD invariants 69–70); EGP keeps that
  separate from `WorkEpisode`. It cannot be silently reused as a WorkEpisode
  settlement rule.

Thus `wait` and `Completed(Yielded)` are valid, and the Work/Verification state
is not erroneous. The unresolved semantic gap is what must happen when the
agent has no safe local recovery and parks the root Work after one or more
terminal action failures: the tree exposes only a generic blocked label, with
no reason or way to act. The Episode's `Completed` discriminator is precise in
the settlement contract; it is not currently shown by these public views.

## Minimal public regression reproduction

Use a fresh isolated production fixture and a scripted Provider that produces
the following same-WorkEpisode sequence: (1) an executable action rejected with
the typed terminal result `ExecutableToolInvocationRejected`; (2) a second
terminally rejected action; (3) a Plan update whose rows are Blocked; (4) a
`wait` action with `Manual`. Do not execute a successful side effect. After the
Episode settles, query only public views:

```text
POST /views/responsibility-tree { projectId }
POST /views/current-work       { workspaceId }
POST /views/attention          { projectId }
POST /views/work-detail        { projectId, workspaceId, workId }
POST /views/workspace-detail   { workspaceId }
POST /views/transcript         { workspaceId, limit: 100, conversationOnly: false }
```

The observed baseline is the responses listed above. The regression
assertion that remains pending governance is that the user can read a durable,
actionable blocker reason and the exact Work/Episode context from a public
surface, and can resume by steering or resolving the named blocker. It must
also assert that Work remains Open, no Verification/Acceptance is fabricated,
and view reads cause zero new Provider or tool calls. This is a failure
reproduction, not an implementation test: the missing projection contract
prevents a legitimate passing expectation from being encoded yet.

## Candidate for manual governance

Define a durable, deduplicated blocked-Work outcome for the exact case where a
WorkEpisode consumes a terminal action failure and settles on `Manual` without
claiming completion. It should expose the bounded typed failure, Work and
Episode identities, and a human/Parent recovery action (for root Work, steer or
change the applicable capability/resource setup, then resume). Decide whether
this is an Action Required Attention fact or a Work Detail episode outcome,
what constitutes proof the blocker is resolved, and how it clears. Keep Plan
content non-authoritative; do not auto-retry, auto-complete, or bypass
Verification/Acceptance. Add a public regression for visibility, resume, and
zero replay before implementation.

Until that choice is accepted, do not add a new Attention source or reinterpret
Manual waits in code. The existing `waiting-blocked` projection is insufficient
to prove the required explanation/recovery path, but it is not a settlement
contract violation.
