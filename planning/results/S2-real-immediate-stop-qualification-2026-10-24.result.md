# Real S2 Immediate Stop Qualification — 2026-10-24

Status: **PASS for the bounded public immediate-Stop journey only**  
Source/test tree: `2f1a0f4c314f452d6da70a062c8fe5bf72f8881f`  
Run: `S2-STOP-3BF669700E`  
Real test duration: 66.74 seconds (Vitest journey: 45.288 seconds)  
Retry: 0; workers: 1

## Scope and invocation

One explicitly opted-in `REAL public S2 exact StopExecution quiescence and
restart` case was run against a fresh isolated fixture, using the previously
authorized production configuration path `C:\Arbor\arbor.config.json`. The
public-real Vitest config and only the immediate-stop test name were selected;
the Normal Steer case was skipped. No preserved or live user database was
used. Credentials and authorization headers were not recorded in this result.

The production provider response was held after a successful bounded Work file
effect. The held capture was correlated to exactly one completion capture by
request ID and sequence 5; the captured upstream response was HTTP 200 with
`finish_reason=tool_calls` and the `read` tool call. The response body was
absent from the raw `response-held` event and came from its validated matching
`response-complete` event. Public `StopExecution` for the exact active
Execution returned a Committed receipt before the held response was released.

## Observed outcome

- The exact stopped Execution became `Interrupted` with
  `StopRequested`; its stop-request timestamp was durable.
- The stopped Execution's ProviderTurn count remained 3 before/after
  quiescence and after restart. Its exact `tool_invocations` facts were
  unchanged after release and restart.
- The bounded file effect remained byte-for-byte the expected one-line
  content; no post-stop patch changed it.
- The public Work remained the same Work at revision 0 and status Open. Its
  public detail had no accepted result. After daemon restart, the same Work and
  revision remained Open, and the stopped Execution's snapshot and tool
  invocation facts matched the post-quiescence snapshot.
- Fixture finalization reported `daemonExited=true`; an independent process
  query found zero matching Node processes. The successful run's disposable
  fixture was cleaned up by the harness.

## Evidence

Private evidence directory (not committed):
`.test-results/real-public-s2-stop-3bf669700e-ZLzfOd/evidence-0vxJmG/`

- Public journey report:
  `public-s2-S2-STOP-3BF669700E-2026-10-23T17-42-43.089Z.json`  
  SHA-256: `8988834B1310B237D55125BCA171F46DAA89CA2F5363EB442C8320CE6E20EAC5`
- Provider capture log: `provider-captures.jsonl`  
  SHA-256: `89F3BD4A6E61CB7A8FF4DB9956AF5C09BABA361705837D17EF2CDF1CBFA4818C`

The private report and capture log contain sensitive test-owned provider
context and are intentionally not included in Git.

## Qualification limits

This result qualifies only the public **immediate StopExecution** journey at
the stated source SHA. It is not a Normal Steer qualification, full S2
qualification, general model reliability claim, or full release qualification.
The test directly compared ProviderTurn and `tool_invocations` facts and the
bounded file contents; it did **not** separately snapshot or assert session
transcript rows or an action-ledger count. Those facts must not be claimed as
independently frozen by this result.

Earlier same-work self-wait and response-capture-correlation failures are
separate historical attempts, not retries or evidence against this run. See
[`S2-real-immediate-stop-terminal-self-wait.result.md`](S2-real-immediate-stop-terminal-self-wait.result.md)
and
[`S2-real-stop-capture-correlation-harness-failure.result.md`](S2-real-stop-capture-correlation-harness-failure.result.md).
