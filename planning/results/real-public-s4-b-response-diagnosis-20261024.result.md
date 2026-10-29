# Real S4-B response and recovery-precondition diagnosis — 2026-10-24

This is a read-only diagnostic of the single corrected-oracle real S4-B run on
candidate `ac9625d99501781f4c787a2cab17319e220318b5`. It does not qualify
S4-B, authorize a retry, or alter production/design code. Full command,
duration, retained-fixture details and file hashes are in
[the S4-B qualification result](real-public-s4-b-approval-hard-restart-20261024.result.md).

## Capture and durable-state findings

- The capture contains 25 `request-start`, 21 `response-complete`, and 4
  `request-failed` records. All captured requests used one daemon PID. The
  four failed ProviderAttempts map to `ConnectTimeout` / `TimedOut`; they have
  no HTTP status. The other 21 upstream responses are HTTP 200. No
  `response-held` or `response-released` event exists.
- Root's conversation request (capture sequences 1–2) advertised only the
  Root control surface. The first response was a valid `assign_work` tool
  call; the second was text with `finish_reason=stop`. Public admission created
  one Open Work. The ensuing WorkEpisode request advertised `shell` (along
  with the Workspace controls) from sequence 3 onward.
- The shared response decoder successfully recognized the two actual
  `wait` tool calls (sequences 9 and 25) and the Root `assign_work` call
  (sequence 1). Across all 21 HTTP-200 response bodies it recognized no
  `shell` call, let alone the exact bounded `shell Get-Date`. Thus the response
  gate had no qualifying authentic response to hold; there is no evidence of
  an SSE-fragment decoder dropping a shell call.
- Read-only SQLite inspection found six Executions: the Root
  `ConversationResponseEpisode`, followed by five `WorkEpisode` Executions
  bound to the same Work. The first four Work attempts settled Failed after
  `ConnectTimeout` outcomes; the fifth settled Completed. The Work itself
  remained Open. All 25 ProviderAttempts used `attempt_no=0`; all 25
  `AgentLoopStep.repair_attempt` values were zero, with no provider-failure or
  repair-disposition payload in those steps.
- The last Work Execution had logical steps 0–16. Step 0 and step 16 were
  `wait` Control actions, each Applied. Steps 1–15 each received a successful
  HTTP-200 text response with `finish_reason=stop` and no tool call. The
  response outputs were recorded as separate Session `AssistantMessage`
  entries, but capture sequences 10–25 submitted the same message-array
  fingerprint `2aecc077abf0` (short SHA-256) on every Provider request while
  the durable logical-step number advanced. This is observable repeated
  context, not proof by itself of why the context builder produced it.
- The DB has one consumed Root `Control` approval. It has zero `Executable`
  approvals, zero `tool_invocations`, zero Sandbox Policy decisions, zero
  Provider recovery decisions, zero projected Attention rows, and zero
  scheduler timers. The Workspace shell grant was present, but the model never
  requested the shell action that could create the durable EAP. The public
  conversation-response job was `Answered`; its HumanMessage row remained
  `Pending` with no claimed Execution. No P1 decision, hard restart, EAP
  approval, shell effect, or S4-B recovery assertion was reached.
- The final fixture evidence says `status=FAIL`, `daemonExited=true`, and
  `daemonErrors=[]`. After teardown, the process inventory had no matching
  Node/Arbor/Vitest process. The retained fixture is a disposable test
  database/workspace and is preserved for audit; it was not modified by this
  diagnostic.

## Per-sequence safe summary

No prompt or response body is reproduced here. Tool names, finish classes,
logical-step bindings and repeated message-array fingerprints are sufficient
to distinguish model choice, decoder behavior and transport failure. Execution
hashes and the Work hash are short SHA-256 pseudonyms, not raw database IDs.
`repair=0` is the persisted `repair_attempt`; generic prompt text mentioning
repair is not counted as a P9 repair attempt.

| Capture sequence | Episode / Execution (short hash) | Step / repair | Advertised surface | Upstream outcome | Safe response class | Context note |
|---:|---|---:|---|---|---|---|
| 1 | ConversationResponse / `1b1eb832` | 0 / 0 | Root controls | HTTP 200 | ToolCall: `assign_work`, `finish=tool_calls` | Root Work admission |
| 2 | ConversationResponse / `1b1eb832` | 1 / 0 | Root controls | HTTP 200 | Text, `finish=stop` | Root response settled |
| 3 | WorkEpisode (`55a342e3`) / `87f4a4af` | 0 / 0 | Workspace, includes `shell` | ConnectTimeout / TimedOut | No HTTP response; capture marks request aborted | No hold |
| 4 | WorkEpisode (`55a342e3`) / `10e05803` | 0 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Repeated input `32a763e95ab8` |
| 5 | WorkEpisode (`55a342e3`) / `10e05803` | 1 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `32a763e95ab8` |
| 6 | WorkEpisode (`55a342e3`) / `10e05803` | 2 / 0 | Workspace, includes `shell` | ConnectTimeout / TimedOut | No HTTP response; capture marks request aborted | No hold |
| 7 | WorkEpisode (`55a342e3`) / `bc115244` | 0 / 0 | Workspace, includes `shell` | ConnectTimeout / TimedOut | No HTTP response; capture marks request aborted | No hold |
| 8 | WorkEpisode (`55a342e3`) / `befba571` | 0 / 0 | Workspace, includes `shell` | ConnectTimeout / TimedOut | No HTTP response; capture marks request aborted | No hold |
| 9 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 0 / 0 | Workspace, includes `shell` | HTTP 200 | ToolCall: `wait`, `finish=tool_calls` | One real Control action |
| 10 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 1 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 11 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 2 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 12 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 3 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 13 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 4 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 14 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 5 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 15 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 6 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 16 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 7 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 17 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 8 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 18 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 9 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 19 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 10 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 20 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 11 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 21 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 12 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 22 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 13 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 23 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 14 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 24 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 15 / 0 | Workspace, includes `shell` | HTTP 200 | Text, `finish=stop` | Same input `2aecc077abf0` |
| 25 | WorkEpisode (`55a342e3`) / `67b0e8d5` | 16 / 0 | Workspace, includes `shell` | HTTP 200 | ToolCall: `wait`, `finish=tool_calls` | Same input `2aecc077abf0` |

## Root-cause assessment

The immediate qualification blocker was **no Provider-selected shell action**:
`shell` was present in the Work tool advertisement, and the same response
parser correctly decoded the actual `assign_work` and `wait` calls, while all
successful Work responses were either text/`stop` or `wait`. Therefore the
selector was not simply waiting on a tool that was absent from the request,
and the captured authentic response bodies provide no indication of a lost
shell SSE fragment. Four `ConnectTimeout` outcomes are real secondary
transport failures, but they do not explain the 21 successful responses that
also did not select shell.

There is a separate **possible nonconvergence/context-refresh issue** worth
isolating: after `wait` at sequence 9, the logical step advanced through 15
text/`stop` results and another `wait`, yet every corresponding request from
sequence 10 through 25 had the same message-array fingerprint. Session rows
showed each intervening AssistantMessage was persisted, while the next
Provider input fingerprint did not change. This is strong evidence of
repeated identical Provider context within that Execution, but this one
model-dependent S4 test does not establish whether the cause is intentional
context projection, loop policy, or a production defect. It warrants a
provider-light/model-light reproduction comparing canonical Session entries
to each exact next Provider request before any production change is proposed.

No design change or production edit is proposed from this run. It is a failed
S4-B precondition only, not evidence of EAP restoration, P1 policy survival,
approval recovery, or effect exactly-once behavior.
