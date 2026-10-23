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
2. Keep the response gate transparent. The real Work Agent must call only
   `shell` with `Get-Date` (no external effect), whose shell policy is
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
git diff --check                                                 PASS
```

The AH7/P38 functional run is reuse evidence using its local scripted
Provider, not real-model or S4-B qualification. The failed real S4-B attempt
itself changed no product source or design; follow-up changes are limited to
the real-provider test/support files and this result record. The S4-A result
remains separate; this record makes no S4-B recovery claim.

Until a run reaches that exact pending EAP and survives restart, do not claim
S4-B.

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
