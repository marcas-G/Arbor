# Real Public S4-B Approval Hard-Restart — Precondition Failure (2026-10-24)

## Run

- Candidate: `ae4b17f06149d93ac8a53ce1f4758bba13c01389`.
- Command selected only `REAL S4-B`, with the explicitly authorized Provider
  config, one worker, retry 0, and a fresh P39 evidence directory:

  ```text
  pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'REAL S4-B' --maxWorkers=1 --retry=0
  ```

- Result: **FAIL at the pending-Executable-Approval precondition; no S4-B
  qualification.** `waitForExecutableApproval` timed out before the test's
  hard-restart/approval sequence. No daemon restart or `ResolveExecutableApproval`
  occurred. No automatic retry was performed.
- Test teardown stopped the fixture. P39 `failure-evidence.json` reports
  `status=FAIL`, `daemonExited=true`, and zero daemon errors. A process check
  found no daemon process. The full failed DB/workspace and capture are retained
  for review at
  `.test-results/real-public-s4-b-work-approval-hard-restart-cCqxjz/`.

## Read-only evidence

- The public resource catalog exposed the available `project-root` profile;
  the test created the fresh project using `Profile` and explicitly granted
  `fs:write` to the WorkspaceAgent.
- The real RootConversation did admit the requested Work: captured model tool
  calls include `assign_work`. The read-only DB has one Open Work, a completed
  WorkEpisode Execution, and one consumed `Control` approval for
  `core.control.assign-work`. Thus Root admission succeeded; the failure was
  not absence of a Work.
- Ten captured Provider exchanges all returned HTTP 200 on the original daemon
  PID. The Work model selected `patch` and `read`; both tool invocations
  succeeded. It also attempted `shell`, which was `NotAdmitted/Denied`.
  The exact requested workspace file already existed before the test reached
  its EAP wait; its SHA-256 matches the test's expected single-line content.
- `action_approvals` contained one row, the consumed Root `Control` approval.
  There was no pending `Executable` approval, no file-wait state, and no
  `ResolveExecutableApproval` action. The current Work remained Open at
  revision 0 after its execution completed. The ConversationResponse job was
  Answered with no active Execution; the HumanMessage row remained Pending and
  its HumanConversation Inbox entry remained visible/unconsumed. This Inbox
  observation does not negate the separately evidenced Work admission.
- All project consumers were caught up at sequence 17 (the project's event
  high-water mark); the workspace had zero scheduler timers. The file and
  fixture are isolated under the disposable test workspace; no live database
  or configured production resource was used.

## Diagnosis and next-run boundary

The prompt said to ask for approval “if required”; it did not require an
approval. The test's exact `fs:write` grant made the model's successful
`patch` route authorized (`patch` is an idempotent action whose registry does
not require EAP), so the Provider completed the write and read before an
Executable Approval existed. Removing that grant alone is not a valid fix:
the missing authority can deny the patch before an approval is required. This
is a test precondition/oracle failure, not evidence that an already-pending
approval failed to survive restart.

The public API used here has no deterministic command to create an arbitrary
Work or inject an Executable Approval. Root Work assignment is a
RootConversation action, and EAP is emitted only after a Work Agent proposes
an action whose exact P4/P1 authority requires approval. Direct SQLite
insertion would invalidate the public-process oracle. Therefore a future S4-B
must retain the real public Root admission and qualify a genuinely approval-
required action before restart. The bounded plan below is implemented in test
source but not qualified by a real S4-B run:

1. The pure response-gate harness validates setupProbe/daemon-environment
   wiring and strict streamed-tool-call decoding. A separate targeted AH7/P38
   functional case validates the existing TrustedLocal P11/EAP fixture route
   with a scripted local Provider. S4 reuses `trusted-local-p11-fixture.ts`;
   it does not copy the long P38 setup.
2. Keep the response gate transparent. Request selection uses advertised
   `shell`; response selection parses the authentic upstream body and holds
   only the exact call. Nonmatching bodies pass through unchanged. The real
   Work Agent must call only `shell` with `Get-Date` (no external effect),
   whose shell policy is
   `RequireApproval`. Setup selects `project-root`, initializes the isolated
   TrustedLocal P11 worktree/authority, captures the workspace baseline, and
   grants `shell:exec` before the Work. The selector holds only that exact
   WorkspaceWork shell response. While the authentic response is held before
   SDK/runtime delivery, read the exact active Execution and grant
   `DecideSandboxPolicy` to it. Release that unchanged response, require one
   shell/Get-Date call and a public pending EAP bound to the same
   Work/Execution/ToolInvocation, with no ToolInvocation or workspace effect
   yet. Commit P1 TrustedLocal policy while EAP remains Pending; P1 supplies
   process context and is not the EAP source.
3. Hard-restart the same fixture DB. Reassert identical
   Work/Execution/EAP/ToolInvocation binding, pending/no-invocation state, the
   committed P1 snapshot, and no effect during a short idle interval. Resolve
   via the public approval command. Require that same invocation to settle
   Success and produce exactly one canonical observation and one ToolResult,
   with no unexpected workspace file mutation and the Work still publicly
   inspectable.
4. Review the helper extraction and light routing evidence independently;
   only then request authorization for at most one real S4-B run. A real Root
   and Work model still select the tool, so this remains a fail-closed
   qualification, not a claim that public setup can eliminate Provider
   variability.

## Provider-light implementation status (not real qualification)

The test-only source wires setupProbe and mutable required daemon environment
through `startRealProviderFixture`; the same base environment is reused by
`ProductionFixture.restart`, including the post-clone private P11 authority
source. The required-environment allowlist is limited to the exact local test
`ARBOR_AUTH_TOKENS` pair and fixture-private
`ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE`; the source path must be absolute and
remain inside the disposable fixture. Other DB/HTTP/project/config/model/
provider/capture/gate/hook keys fail closed. S4-B's restart override explicitly
disables the old response gate.

S4-B now requires the exact captured shell `Get-Date` call, exact public
Executable Approval/action binding, P1 commit while EAP is Pending, same
Work/Execution/EAP after restart, no newly issued WorkspaceWork Provider
request or invocation during a 1.5-second idle window, and the same invocation
settling Success. A read-only execution-wide SQL snapshot requires exactly one
ToolInvocation, one consumed EAP, one canonical `_tag: Success` bounded
observation, one matching ToolResult, and no extra Pending EAP/tool action. It
also requires an unchanged workspace snapshot and a publicly inspectable
Work. These counts apply only to this S4-B Execution, not system-wide
exactly-once behavior. P1 `TrustedLocalUnconfinedV1` is fixture-only context
and does **not** qualify an OS-enforced sandbox.

Source-only/provider-light validation:

```text
pnpm exec tsc -p tsconfig.test.json --noEmit                         PASS
pnpm exec biome check <three S4/support test files>                 PASS
pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s0-response-gate.test.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'response gate capture contract|S4-B gate requires' --maxWorkers=1 --retry=0 --no-file-parallelism
  10 passed, 2 REAL S4 cases skipped
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts --testNamePattern 'resumes a NotAdmitted shell intent from its persisted ProviderTurn' --maxWorkers=1 --retry=0 --no-file-parallelism
  1 passed, 24 skipped (isolated functional daemon + scripted local Provider)
pnpm exec vitest run --config vitest.config.ts tests/capability/support/provider-fetch-capture-hook.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism
  2 passed (stub fetch; nonmatching text passed through, exact fragmented SSE call held)
git diff --check                                                 PASS
```

The AH7/P38 functional run is reuse evidence using its local scripted
Provider, not real-model or S4-B qualification. The failed real S4-B attempt
itself changed no product source or design; follow-up changes are limited to
the real-provider test/support files and this result record. The S4-A result
remains separate; this record makes no S4-B recovery claim.

Until a run reaches that exact pending EAP and survives restart, do not claim
S4-B.

## Final authorized S4-B attempt — 2026-10-24

- Candidate: `5048f8657eccbd78fe7e573588e209a874f2434f` (P41 independent
  final review PASS).
- Before start, no prior Arbor functional daemon or listener owned by a test
  process was present. The run used the explicit authorized config path, one
  worker, retry 0, no file parallelism, and only `REAL S4-B`:

  ```text
  pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'REAL S4-B' --maxWorkers=1 --retry=0 --no-file-parallelism
  ```

- Exit: **1**. Duration: **67.68 seconds** (Vitest reported 1 failed and 2
  skipped; S4-A and the S4-B parser unit were not selected). The test timed out
  in `admitRootWorkThroughPublicConversation` because its helper required the
  model-authored Work objective to echo the marker. Root admission actually
  succeeded: the DB shows one Open Work and an active WorkEpisode Execution;
  the public helper only failed to recognize that Work after its objective
  paraphrased the goal without the marker.
- The selected response gate held the third Provider exchange because the
  request advertised `shell` and contained the marker, but the authentic held
  HTTP 200 body was **text, with no tool call**. Captures show three request
  starts and completions on one old PID; response 1 called `assign_work`, and
  responses 2 and 3 contained no tool calls. One response was held. The test
  failed before the exact Get-Date decoder, P4 EAP, P1 commit, hard restart or
  approval sequence. No S4-B recovery claim is supported by this run.
- Read-only archive inspection confirms one consumed Root `Control`
  `assign_work` approval, no `Executable` approval, no `tool_invocations`, no
  file effect, and an Open Work with an unsettled active Execution. P39
  `failure-evidence.json` reports `status=FAIL`, `daemonExited=true`, zero
  daemon errors. Process inspection after teardown found no daemon process.
  The fixture DB/workspace and private captures remain retained at
  `.test-results/real-public-s4-b-work-approval-hard-restart-qRER1A/`.
- No automatic second real run was performed.

This run identifies two narrow test-oracle gaps, not a production defect:

1. Public Work admission must not require the generated `objective` to echo a
   prompt marker. Record the fresh Workspace's pre-submit `current-work` as
   empty, resolve the exact public Root control approval, then take the newly
   returned public `current-work.workId` and validate its public Work detail
   and active Execution. No Work objective substring is needed.
2. The response-gate selector previously matched request advertisement/text,
   so it could hold a non-tool text response. This is now fixed in the
   test-only MJS selector: it decodes the authentic upstream body, supports
   fragmented SSE tool-call fields, and holds only one matching bounded
   workspace `shell Get-Date`; nonmatching real responses pass through
   unchanged. The TypeScript assertion aliases the same decoder, and the held
   request is independently tied to the exact public Work via its structured
   `WorkAssigned(workId, workspaceId)` result plus a read-only
   `WorkEpisode/episode_ref` binding. Admission no longer compares the
   model-authored objective with a marker.

Do not run another real S4-B until these changes pass provider-light tests and
independent review and the user/root explicitly authorizes another attempt.

No source or design document was changed by this run. The S4-A result remains
separate; this record makes no S4-B recovery claim.

## Private evidence hashes

| File | SHA-256 |
|---|---|
| `evidence-sCo0wG/provider-captures.jsonl` | `CB70FF7EBA5A0630A2173A46D6AB05AB77DF1F161641DE3B52BA156FC464C5F5` |
| `evidence-sCo0wG/s4-b-work-approval-hard-restart-2026-10-23T19-24-25.232Z.json` | `93AF4068619FCF949F5F8E1096B9DE3DB780B8A058E8E96787EFF2890C0495AF` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/.arbor-p39-writer-963430633335402ad79cc83cd2167c5fedd24907fb7676770ddb4358d63d79bb.sqlite` | `9E35DAA0E5EB81F6D0E9A88B1F9BA6DFAE6A5E92937C8796A9212B2F2833B1DB` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/arbor-functional-p39-report.db` | `BF7EA8CAA43531682F6C75D95FCFAF21855361D73601DC20DBE1045C77784618` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/failure-evidence.json` | `0AB09CEDA72C0C58A5A0A17FF00F4679BE85F9A4118E580EFE55B62A88464EB3` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/arbor-functional.db` | `D226EAABC2150BE37956B9F1B13E1141F97E60CE0922D0839122929C8F0A3F56` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/arbor-functional.db-shm` | `42A97B1D1EE102CDEE363C291466C44115A0D50EDF4BF49EC1BF59F625355C54` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/arbor-functional.db-wal` | `EFA6DCBEE9EEAD71BC9168321E7A6CE6FAAC3CDA0BB0573AED2339FA5959F2D8` |
| `retained-fixture-a25b21e3-c02d-4176-ab8c-a0961a803783/workspace/s4-approval-s4b-4c4b541baa.txt` | `4DC99C324702C813BB5CB4C7C748062A1D25B39C8C1628FF77164E66FC9B517D` |

Latest failed-attempt private evidence hashes:

| File | SHA-256 |
|---|---|
| `evidence-dHJAIN/provider-captures.jsonl` | `B5FF6872293E296EF1E2ACE8D41215C53A215AAD500E2D7509C3692D4BB19920` |
| `evidence-dHJAIN/s4-b-work-approval-hard-restart-2026-10-23T20-03-17.554Z.json` | `94BBA1D7748075B81AC73FF680A37F72350730B624E73AFE6BC7CED63F754421` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/.arbor-p39-writer-018827a4292247eec3f57986fac7da695a3b47ecf67c65e73caa4afb3b0f0280.sqlite` | `9E35DAA0E5EB81F6D0E9A88B1F9BA6DFAE6A5E92937C8796A9212B2F2833B1DB` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/arbor-functional-p39-report.db` | `BF7EA8CAA43531682F6C75D95FCFAF21855361D73601DC20DBE1045C77784618` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/failure-evidence.json` | `1E1085574457CFA5BEAC9569B99652019D4BBC20943E449301079277BD95148D` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/arbor-functional.db` | `8D8D3F7DB556F5A1C64F872E3B31F3FD067D24F7FA94A1A71470D2F4743F562F` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/arbor-functional.db-shm` | `A541C1CB95B6B97605EC7089C174049F44C86371EFA8835D7E06592C3CFE2987` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/arbor-functional.db-wal` | `3E4FA5C784800FF6A898C29947531BD2DF53BC87A70E0CD97EF2BF34BAF06E98` |
| `retained-fixture-af296500-9a18-4877-9fd4-def97fa3101e/workspace/v2-source.json` | `A087F7A5E0FAD2D769FF7FA12A39EB3275579D09C55D25B67A8F77BF82349509` |

## Corrected-oracle real qualification — 2026-10-24

- Candidate: `ac9625d99501781f4c787a2cab17319e220318b5`.
- Before start, process inventory found no existing Arbor/Vitest functional
  daemon. The configured Provider file path was passed through the test's
  private-config environment variable; its contents and credentials were not
  printed. Evidence root was the candidate's canonical `.test-results`.
- The sole actual qualification command (retry 0, one worker, no file
  parallelism; S4-B only) was:

  ```text
  $env:ARBOR_PUBLIC_S1_CONFIG='C:\Arbor\arbor.config.json'
  $env:ARBOR_PUBLIC_REAL_EVIDENCE_ROOT=(Resolve-Path '.test-results').Path
  $env:ARBOR_RUN_REAL_PUBLIC_S4='1'
  pnpm exec vitest run --config vitest.public-real.config.ts tests/capability/real-provider/public-s4-recovery.test.ts --testNamePattern 'REAL S4-B' --maxWorkers=1 --retry=0 --no-file-parallelism
  ```

- Result: **FAIL / not qualified**. Vitest exit 1; the S4-B case ran for
  `1,211,251 ms` and the complete process for `1,232.41 s` (1 failed, 2
  skipped). The bounded failure was `REAL NOT QUALIFIED: deadline waiting for
  a genuine held Provider response` at `waitForHeldProviderResponse`. S4-A
  and the parser unit were skipped by the name filter. No EAP, P1 commit,
  hard restart, approval, or effect was reached; this is not an approval
  recovery result.
- The response-gate/capture diagnosis is recorded separately in
  [the S4-B provider-response diagnosis](real-public-s4-b-response-diagnosis-20261024.result.md).
  In brief, shell was advertised on the WorkspaceWork requests, but no real
  response contained the exact bounded `shell Get-Date` call. Of 25 captured
  request starts, 21 completed HTTP 200 and 4 ended as aborted/ConnectTimeout;
  there were zero `response-held` or `response-released` records. The captured
  responses that completed had valid text/tool-call shapes; there is no
  evidence that the shared fragmented-SSE decoder dropped a shell call.
- Read-only DB inspection found one Open Work and its WorkEpisode executions;
  one later Work Execution completed after repeated nonmatching model turns.
  There was one consumed Root `Control` approval, but zero `Executable`
  approvals, `tool_invocations`, or Sandbox Policy decisions. The human
  request/job remained pending/answered according to their separate
  conversation-response rows; no EAP or restart occurred. Failure evidence
  reports `daemonExited=true` and zero daemon errors. Post-teardown process
  inventory found no Node/Arbor/Vitest processes.
- P39 retained this failed run at
  `.test-results/real-public-s4-b-work-approval-hard-restart-rbuVST/`, including
  the retained disposable DB/workspace, response captures, and failure
  evidence. The capture/evidence and DB/WAL were hashed after teardown. The
  untracked fixture `.arbor-functional-schema44-vkMFK7/` was not touched.
- This is the first real attempt against the corrected S4-B oracle and it
  **does not qualify S4-B**. There was no automatic retry or second real run.

### Corrected-oracle private evidence hashes

| File | SHA-256 |
|---|---|
| `evidence-ykygaj/provider-captures.jsonl` | `03BFD44005170136A3662E6E47114440FBE7C952C79A47DD0CB5F20974BA5A87` |
| `evidence-ykygaj/s4-b-work-approval-hard-restart-2026-10-23T20-42-57.753Z.json` | `D887B0D9CB4D51B3C5D5620B25B8B1B0C7986BDAAA3F8A163E25168D8CDF97BA` |
| `retained-fixture-226d4ea1-05e2-4046-8d2d-f7af8cbdc14c/failure-evidence.json` | `7D96527824C03164F6A1103D70F48B27A2C0A35597D6691DEDACDA97488F322C` |
| `retained-fixture-226d4ea1-05e2-4046-8d2d-f7af8cbdc14c/arbor-functional.db` | `87C8D23E7C43E7C60FA421C9C8D9D08E05CB2BD3BC5D186E774F677D1B4485E1` |
| `retained-fixture-226d4ea1-05e2-4046-8d2d-f7af8cbdc14c/arbor-functional.db-wal` | `57E03151297F89FD380D41B16F8FA515303C8C9089428B0A30B48143FF43A969` |
| `retained-fixture-226d4ea1-05e2-4046-8d2d-f7af8cbdc14c/arbor-functional-p39-report.db` | `BF7EA8CAA43531682F6C75D95FCFAF21855361D73601DC20DBE1045C77784618` |
| `retained-fixture-226d4ea1-05e2-4046-8d2d-f7af8cbdc14c/.arbor-p39-writer-229803429d7c1468cc4c38d684cb0c96758dfd4c955a7787f675370c5ece299b.sqlite` | `9E35DAA0E5EB81F6D0E9A88B1F9BA6DFAE6A5E92937C8796A9212B2F2833B1DB` |
