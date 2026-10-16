import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../support/lease-qualification.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForExecutableApproval,
  waitForPublic,
} from "../support/public-client.js";

interface ExecutableApprovalRow {
  readonly approval_id: string;
  readonly execution_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly tool_invocation_id: string;
  readonly side_effect_semantics: string;
  readonly state: string;
  readonly revision: number;
  readonly cancelled_at: string | null;
  readonly cancellation_reason: string | null;
  readonly consumed_at: string | null;
  readonly consumed_by: string | null;
}

interface ApprovalSnapshot {
  readonly execution:
    | {
        readonly stop_requested_at: string | null;
        readonly settlement_kind: string | null;
        readonly settlement_json: string | null;
      }
    | undefined;
  readonly approval: ExecutableApprovalRow | undefined;
  readonly inboxConsumedAt: string | null | undefined;
  readonly approvalEvents: ReadonlyArray<{
    readonly event_type: string;
    readonly payload_json: string;
  }>;
  readonly executionStopEventCount: number;
  readonly step:
    | {
        readonly provider_turn_id: string;
        readonly state: string;
      }
    | undefined;
  readonly action: { readonly state: string } | undefined;
  readonly invocation:
    | {
        readonly invocation_id: string;
        readonly approval_id: string | null;
        readonly effect_admission_state: string;
        readonly settlement_kind: string | null;
        readonly settlement_json: string | null;
      }
    | undefined;
  readonly effectCount: number;
  readonly matchingInvocationCount: number;
  readonly executionApprovalCount: number;
  readonly recoveryBinding:
    | {
        readonly recovery_binding_state: string;
        readonly recovery_binding_sha256: string | null;
        readonly canonical_binding_json: string | null;
        readonly binding_sha256: string | null;
      }
    | undefined;
  readonly attempt0:
    | {
        readonly attempt_no: number;
        readonly admission_state: string;
        readonly admission_source: string;
        readonly admission_time_precision: string;
        readonly binding_sha256: string | null;
      }
    | undefined;
}

const fixtures: ProductionFixture[] = [];
const p4FenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);

interface ApprovalFixtureQualificationOptions {
  readonly firstDaemonEntry?: string;
  readonly daemonEnvironment?: Readonly<Record<string, string>>;
  readonly onDaemonStdout?: (line: string) => void;
  readonly preserveDirectoryOnStop?: boolean;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const startExecutableApproval = async (
  marker: string,
  qualification: ApprovalFixtureQualificationOptions = {},
) => {
  const destination = `p38-moved-${marker}.txt`;
  const effectLog = `p38-effects-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${marker}'; mv -LiteralPath 'proof.txt' -Destination '${destination}'; Write-Output '${marker}' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${marker}' >> '${effectLog}' && mv proof.txt '${destination}' && printf '%s\\n' '${marker}'; fi`;

  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    ...(qualification.firstDaemonEntry === undefined
      ? {}
      : { firstDaemonEntry: qualification.firstDaemonEntry }),
    ...(qualification.daemonEnvironment === undefined
      ? {}
      : { daemonEnvironment: qualification.daemonEnvironment }),
    ...(qualification.onDaemonStdout === undefined
      ? {}
      : { onDaemonStdout: qualification.onDaemonStdout }),
    ...(qualification.preserveDirectoryOnStop === true
      ? { preserveDirectoryOnStop: true }
      : {}),
    reply: (call) => {
      const names = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      const context = JSON.stringify(call.messages);
      if (
        names.has("assign_work") &&
        !names.has("claim_completion") &&
        context.includes(marker)
      ) {
        if (context.includes("WorkAssigned(")) {
          return { _tag: "Text", text: `Work admitted for ${marker}` };
        }
        return {
          _tag: "ToolCall",
          name: "assign_work",
          arguments: {
            objective: `Move proof.txt and write ${marker} exactly once.`,
            why: "qualify durable Executable approval",
            constraints: ["do not access external resources"],
            completionExpectation: "the approved shell action is reconciled",
            verificationMission: {
              goal: `Verify the approved action ${marker}`,
              criteria: [
                {
                  criterionId: "approved-effect",
                  requirement: `the effect log contains ${marker} once`,
                  required: true,
                },
              ],
              riskRequirements: ["no external side effects"],
            },
            reason: "P38 executable approval functional qualification",
          },
        };
      }
      if (
        names.has("shell") &&
        names.has("claim_completion") &&
        context.includes(marker)
      ) {
        const effectReturned = call.messages.some(
          (message) =>
            message.role === "tool" && message.content?.includes(marker),
        );
        return effectReturned
          ? { _tag: "Text", text: `Observed approved effect ${marker}` }
          : {
              _tag: "ToolCall",
              name: "shell",
              arguments: {
                command,
                cwd: { mount: "workspace", path: "." },
                timeoutMs: 5_000,
              },
            };
      }
      return { _tag: "Text", text: `Waiting for ${marker}` };
    },
  });
  fixtures.push(fixture);
  if (qualification.preserveDirectoryOnStop === true) {
    console.info(
      `P38 retained process fixture: marker=${marker} directory=${fixture.directory} database=${fixture.databaseFile} workspace=${fixture.workspaceDirectory}`,
    );
  }

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `P38 executable approval ${marker}`,
    { resourceSelection: "Profile" },
  );
  await client.command(project.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
    capability: "shell:exec",
    target: project.rootWorkspaceId,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  await submitHumanMessage(
    client,
    project,
    `请完成 ${marker}：把 proof.txt 移到 ${destination}，并在副作用日志中记录一次。`,
  );

  const workApproval = await waitForApproval(client, project, marker);
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: workApproval.approvalId,
    expectedRevision: workApproval.revision,
    decision: "Approve",
    reason: "admit the Work whose shell action is separately gated",
  });

  const { approvalId, revision } = await waitForExecutableApproval(
    client,
    project.rootWorkspaceId,
    marker,
    60_000,
  );
  const snapshot = () =>
    readApprovalSnapshot(
      fixture.databaseFile,
      fixture.workspaceDirectory,
      approvalId,
      effectLog,
    );
  const before = snapshot();
  if (before.approval === undefined || before.step === undefined) {
    throw new Error(
      `P38 approval did not bind a durable AgentLoopStep for ${marker}`,
    );
  }
  expect(before.approval.state).toBe("Pending");
  expect(before.approval.revision).toBe(0);
  expect(before.invocation).toBeUndefined();
  expect(before.effectCount).toBe(0);

  return {
    client,
    fixture,
    project,
    approvalId,
    revision,
    marker,
    effectLog,
    before,
    snapshot,
  };
};

const readApprovalSnapshot = (
  databaseFile: string,
  workspaceDirectory: string,
  approvalId: string,
  effectLog: string,
): ApprovalSnapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const approval = db
      .prepare(
        `SELECT approval_id, execution_id, project_id, workspace_id,
                logical_step_no, repair_attempt, action_index, logical_action_id,
                call_ref, tool_invocation_id, side_effect_semantics, state,
                revision, cancelled_at, cancellation_reason, consumed_at,
                consumed_by
           FROM action_approvals
          WHERE approval_id = ? AND route_kind = 'Executable' AND binding_proven = 1`,
      )
      .get(approvalId) as ExecutableApprovalRow | undefined;
    const step =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT provider_turn_id, state FROM agent_loop_steps
                WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?`,
            )
            .get(
              approval.execution_id,
              approval.logical_step_no,
              approval.repair_attempt,
            ) as ApprovalSnapshot["step"]);
    const execution =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT stop_requested_at, settlement_kind, settlement_json
                 FROM executions WHERE execution_id = ?`,
            )
            .get(approval.execution_id) as ApprovalSnapshot["execution"]);
    const inboxRow =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT consumed_at FROM inbox_entries
                WHERE workspace_id = ? AND entry_key = ?`,
            )
            .get(approval.workspace_id, `eap:${approval.approval_id}:0`) as
            | { readonly consumed_at: string | null }
            | undefined);
    const approvalEvents =
      approval === undefined
        ? []
        : (db
            .prepare(
              `SELECT event_type, payload_json FROM domain_events
                WHERE aggregate_ref = ? ORDER BY sequence`,
            )
            .all(
              approval.approval_id,
            ) as unknown as ApprovalSnapshot["approvalEvents"]);
    const executionStopEventCount =
      approval === undefined
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count FROM domain_events
                    WHERE aggregate_ref = ? AND event_type = 'ExecutionStopRequested'`,
                )
                .get(approval.execution_id) as { readonly count: number }
            ).count,
          );
    const action =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT state FROM agent_loop_step_actions
                WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?
                  AND action_index = ? AND logical_action_id = ? AND route_kind = 'Executable'`,
            )
            .get(
              approval.execution_id,
              approval.logical_step_no,
              approval.repair_attempt,
              approval.action_index,
              approval.logical_action_id,
            ) as ApprovalSnapshot["action"]);
    const invocation =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT invocation_id, approval_id, effect_admission_state,
                      settlement_kind, settlement_json FROM tool_invocations
                WHERE execution_id = ? AND invocation_id = ?`,
            )
            .get(approval.execution_id, approval.tool_invocation_id) as
            | ApprovalSnapshot["invocation"]
            | undefined);
    const effectPath = join(workspaceDirectory, effectLog);
    const effectText = existsSync(effectPath)
      ? readFileSync(effectPath, "utf8")
      : "";
    const effectCount = effectText
      .split(/\r?\n/u)
      .filter((line) => line.length > 0).length;
    const matchingInvocationCount =
      approval === undefined
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count FROM tool_invocations
                    WHERE execution_id = ? AND approval_id = ?`,
                )
                .get(approval.execution_id, approvalId) as {
                readonly count: number;
              }
            ).count,
          );
    const executionApprovalCount =
      approval === undefined
        ? 0
        : Number(
            (
              db
                .prepare(
                  `SELECT COUNT(*) AS count FROM action_approvals
                    WHERE execution_id = ? AND route_kind = 'Executable'
                      AND binding_proven = 1`,
                )
                .get(approval.execution_id) as { readonly count: number }
            ).count,
          );
    const recoveryBinding =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT i.recovery_binding_state, i.recovery_binding_sha256,
                      b.canonical_binding_json, b.binding_sha256
                 FROM tool_invocations AS i
                 LEFT JOIN tool_invocation_recovery_bindings AS b
                   ON b.invocation_id = i.invocation_id
                WHERE i.execution_id = ? AND i.invocation_id = ?`,
            )
            .get(approval.execution_id, approval.tool_invocation_id) as
            | ApprovalSnapshot["recoveryBinding"]
            | undefined);
    const attempt0 =
      approval === undefined
        ? undefined
        : (db
            .prepare(
              `SELECT attempt_no, admission_state, admission_source,
                      admission_time_precision, binding_sha256
                 FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? AND attempt_no = 0`,
            )
            .get(approval.tool_invocation_id) as
            | ApprovalSnapshot["attempt0"]
            | undefined);
    return {
      execution,
      approval,
      inboxConsumedAt: inboxRow?.consumed_at,
      approvalEvents,
      executionStopEventCount,
      step,
      action,
      invocation,
      effectCount,
      matchingInvocationCount,
      executionApprovalCount,
      recoveryBinding,
      attempt0,
    };
  } finally {
    db.close();
  }
};

const resolveApproval = async (
  client: ReturnType<typeof makePublicClient>,
  projectId: string,
  approvalId: string,
  revision: number,
  decision: "Approve" | "Reject",
) =>
  client.command(projectId, "ResolveExecutableApproval", {
    approvalId,
    expectedRevision: revision,
    decision,
    reason: `P38 public ${decision.toLowerCase()} qualification`,
  });

const expireStoppedInitialOwner = async (
  run: Awaited<ReturnType<typeof startExecutableApproval>>,
) => {
  const executionId = run.before.approval?.execution_id;
  const owner = run.fixture.daemonProcessSnapshot();
  if (executionId === undefined || owner === null || owner.pid === undefined) {
    throw new Error("P38 Stop owner identity was unavailable before exit");
  }
  const db = new DatabaseSync(run.fixture.databaseFile, { readOnly: true });
  let lease:
    | {
        readonly worker_id: string;
        readonly worker_incarnation_id: string;
        readonly generation: number;
        readonly expires_at: string;
      }
    | undefined;
  try {
    lease = db
      .prepare(
        `SELECT worker_id, worker_incarnation_id, generation, expires_at
           FROM execution_leases WHERE execution_id = ?`,
      )
      .get(executionId) as typeof lease;
  } finally {
    db.close();
  }
  if (lease === undefined) {
    throw new Error("P38 Stop owner lease was absent before process exit");
  }
  await run.fixture.crash();
  const exited = run.fixture.daemonProcessSnapshot();
  if (exited === null || exited.alive || exited.pid !== owner.pid) {
    throw new Error("P38 Stop owner did not exit before exact lease expiry");
  }
  return expireExecutionLeaseAfterOwnerExitForQualification({
    databaseFile: run.fixture.databaseFile,
    executionId,
    expected: {
      generation: lease.generation,
      expiresAt: lease.expires_at,
      workerId: lease.worker_id,
      workerIncarnationId: lease.worker_incarnation_id,
    },
    daemon: {
      crash: run.fixture.crash,
      snapshot: run.fixture.daemonProcessSnapshot,
    },
    ownerEvidence: {
      executionId,
      processId: owner.pid,
      workerId: lease.worker_id,
      workerIncarnationId: lease.worker_incarnation_id,
      generation: lease.generation,
      provenance: "DurableGenerationWithStableIncarnation",
    },
  });
};

const waitForResumedAction = async (
  snapshot: () => ApprovalSnapshot,
  terminalState: "Consumed" | "Rejected" | "Expired",
) => {
  const expectedActionState =
    terminalState === "Consumed" ? "Applied" : "TerminalRejected";
  const expectedSettlement =
    terminalState === "Consumed" ? "Success" : "Denied";
  const expectedEffectCount = terminalState === "Consumed" ? 1 : 0;
  return waitForPublic(
    async () => snapshot(),
    (value) =>
      value.approval?.state === terminalState &&
      value.action?.state === expectedActionState &&
      value.invocation?.settlement_kind === expectedSettlement &&
      value.effectCount === expectedEffectCount,
    45_000,
  );
};

describe("pending P38 public Executable approval qualification", () => {
  it("enforces public ResolveExecutableApproval authority and stale-revision receipt semantics", async () => {
    const marker = `P38-RESOLVE-REJECT-${crypto.randomUUID().slice(0, 8)}`;
    const run = await startExecutableApproval(marker);
    const writeSnapshot = () => {
      const db = new DatabaseSync(run.fixture.databaseFile, { readOnly: true });
      try {
        return {
          commands: Number(
            (
              db.prepare("SELECT COUNT(*) AS count FROM commands").get() as {
                readonly count: number;
              }
            ).count,
          ),
          events: Number(
            (
              db
                .prepare("SELECT COUNT(*) AS count FROM domain_events")
                .get() as {
                readonly count: number;
              }
            ).count,
          ),
        };
      } finally {
        db.close();
      }
    };
    const writesBefore = writeSnapshot();
    const postAsActor = async (
      actor: string,
      expectedRevision: number,
      commandId = functionalId("cmd"),
    ) => {
      const response = await fetch(`${run.fixture.baseUrl}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local",
        },
        body: JSON.stringify({
          commandType: "ResolveExecutableApproval",
          commandId,
          projectId: run.project.projectId,
          actor,
          issuedAt: new Date().toISOString(),
          payload: {
            approvalId: run.approvalId,
            expectedRevision,
            decision: "Approve",
            reason: "P38 unauthorized/stale no-write qualification",
          },
        }),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    const unauthorized = await postAsActor("user:intruder", run.revision);
    expect(unauthorized).toEqual({
      status: 403,
      body: {
        ok: false,
        status: 403,
        problem: {
          code: "authority/denied",
          category: "forbidden",
          message: "authority/denied",
          correlationId: null,
          retryDisposition: "non-retryable",
          safeDetails: { reason: "principal/actor-mismatch" },
        },
      },
    });
    expect(writeSnapshot()).toEqual(writesBefore);
    expect(run.snapshot()).toEqual(run.before);

    const staleCommandId = functionalId("cmd");
    const stale = await postAsActor(
      "user:local",
      run.revision + 1,
      staleCommandId,
    );
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({
      ok: true,
      status: 200,
      body: {
        commandId: staleCommandId,
        resolution: "TerminalRejected",
        rejection: "RevisionConflict",
      },
    });
    const writesAfterStale = writeSnapshot();
    expect(writesAfterStale).toEqual({
      commands: writesBefore.commands + 1,
      events: writesBefore.events,
    });
    expect(run.snapshot()).toEqual(run.before);
    const staleReplay = await postAsActor(
      "user:local",
      run.revision + 1,
      staleCommandId,
    );
    expect(staleReplay).toEqual(stale);
    expect(writeSnapshot()).toEqual(writesAfterStale);
    expect(run.snapshot()).toEqual(run.before);
  }, 120_000);

  it("approves over the public API and resumes the same Execution/AgentLoopStep", async () => {
    const marker = `P38-APPROVE-${crypto.randomUUID().slice(0, 8)}`;
    const run = await startExecutableApproval(marker);
    const approved = await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    expect(approved).toMatchObject({ body: { resolution: "Committed" } });

    const resumed = await waitForResumedAction(run.snapshot, "Consumed");
    expect(resumed.approval?.state).toBe("Consumed");
    expect(resumed.approval).toMatchObject({
      execution_id: run.before.approval?.execution_id,
      logical_step_no: run.before.approval?.logical_step_no,
      repair_attempt: run.before.approval?.repair_attempt,
      action_index: run.before.approval?.action_index,
      logical_action_id: run.before.approval?.logical_action_id,
      tool_invocation_id: run.before.approval?.tool_invocation_id,
    });
    expect(resumed.step?.provider_turn_id).toBe(
      run.before.step?.provider_turn_id,
    );
    expect(resumed.action?.state).toBe("Applied");
    expect(resumed.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      settlement_kind: "Success",
    });
    expect(resumed.effectCount).toBe(1);
  });

  it.each(["Reject", "Expire"] as const)(
    "%s is terminal, resumes the original action without admitting the shell effect",
    async (resolution) => {
      const marker = `P38-${resolution.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const run = await startExecutableApproval(marker);
      if (resolution === "Reject") {
        const rejected = await resolveApproval(
          run.client,
          run.project.projectId,
          run.approvalId,
          run.revision,
          "Reject",
        );
        expect(rejected).toMatchObject({ body: { resolution: "Committed" } });
      } else {
        const db = new DatabaseSync(run.fixture.databaseFile);
        try {
          db.prepare(
            "UPDATE action_approvals SET expires_at = ? WHERE approval_id = ? AND route_kind = 'Executable' AND state = 'Pending' AND revision = ?",
          ).run("2000-01-01T00:00:00.000Z", run.approvalId, run.revision);
        } finally {
          db.close();
        }
      }

      const resumed = await waitForResumedAction(
        run.snapshot,
        resolution === "Reject" ? "Rejected" : "Expired",
      );
      expect(resumed.approval?.state).toBe(
        resolution === "Reject" ? "Rejected" : "Expired",
      );
      expect(resumed.approval?.execution_id).toBe(
        run.before.approval?.execution_id,
      );
      expect(resumed.approval?.logical_step_no).toBe(
        run.before.approval?.logical_step_no,
      );
      expect(resumed.approval?.logical_action_id).toBe(
        run.before.approval?.logical_action_id,
      );
      expect(resumed.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(resumed.action?.state).toBe("TerminalRejected");
      expect(resumed.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        settlement_kind: "Denied",
      });
      expect(
        JSON.parse(resumed.invocation?.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "Denied",
        reasonCode:
          resolution === "Reject" ? "ApprovalRejected" : "ApprovalExpired",
      });
      expect(resumed.effectCount).toBe(0);
    },
  );

  it("survives restart with two daemons and consumes one approval/effect", async () => {
    const marker = `P38-TAKEOVER-${crypto.randomUUID().slice(0, 8)}`;
    const run = await startExecutableApproval(marker);
    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    await run.fixture.crash();
    await run.fixture.restart();
    const peer = await run.fixture.startAdditionalDaemon({
      entry: resolve("apps/single-workspace/dist/main.js"),
    });
    try {
      const recovered = await waitForResumedAction(run.snapshot, "Consumed");
      expect(recovered.approval?.state).toBe("Consumed");
      expect(recovered.approval).toMatchObject({
        execution_id: run.before.approval?.execution_id,
        logical_step_no: run.before.approval?.logical_step_no,
        logical_action_id: run.before.approval?.logical_action_id,
        tool_invocation_id: run.before.approval?.tool_invocation_id,
      });
      expect(recovered.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(recovered.action?.state).toBe("Applied");
      expect(recovered.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        settlement_kind: "Success",
      });
      expect(recovered.effectCount).toBe(1);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });

  it("rolls back a same-Step P38/P4/P39 claim killed inside its transaction", async () => {
    const marker = `P38-P39-CLAIM-PRECOMMIT-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly branch?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      firstDaemonEntry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "P4P39ClaimBeforeCommit",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "P4_FENCE_PROBE") probes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });
    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
    });
    try {
      await resolveApproval(
        run.client,
        run.project.projectId,
        run.approvalId,
        run.revision,
        "Approve",
      );
      const beforeCommit = await waitForPublic(
        async () =>
          probes.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "P4P39ClaimBeforeCommit",
          ),
        (event) => event !== undefined,
        60_000,
      );
      if (beforeCommit === undefined) {
        throw new Error("P38/P39 before-commit claim probe was absent");
      }
      expect(beforeCommit.executionId).toBe(run.before.approval?.execution_id);
      expect(beforeCommit.invocationId).toBe(
        run.before.approval?.tool_invocation_id,
      );

      const owner = run.fixture.daemonProcessSnapshot();
      const targetExecutionId = run.before.approval?.execution_id;
      if (
        owner === null ||
        owner.pid === undefined ||
        targetExecutionId === undefined
      ) {
        throw new Error("old P38 claim owner PID was absent");
      }
      const leaseDb = new DatabaseSync(run.fixture.databaseFile, {
        readOnly: true,
      });
      let lease:
        | {
            readonly worker_id: string;
            readonly worker_incarnation_id: string;
            readonly generation: number;
            readonly expires_at: string;
          }
        | undefined;
      try {
        lease = leaseDb
          .prepare(
            `SELECT worker_id, worker_incarnation_id, generation, expires_at
               FROM execution_leases WHERE execution_id = ?`,
          )
          .get(targetExecutionId) as typeof lease;
      } finally {
        leaseDb.close();
      }
      if (lease === undefined) {
        throw new Error("same-Step old owner lease was absent before kill");
      }

      await run.fixture.crash();
      expect(run.fixture.daemonProcessSnapshot()?.alive).toBe(false);
      const rolledBack = run.snapshot();
      expect(rolledBack.approval).toMatchObject({
        state: "Approved",
        consumed_by: null,
      });
      expect(rolledBack.action?.state).toBe("Pending");
      expect(rolledBack.invocation).toBeUndefined();
      expect(rolledBack.recoveryBinding).toBeUndefined();
      expect(rolledBack.attempt0).toBeUndefined();
      expect(rolledBack.effectCount).toBe(0);

      const expired = await expireExecutionLeaseAfterOwnerExitForQualification({
        databaseFile: run.fixture.databaseFile,
        executionId: targetExecutionId,
        expected: {
          generation: lease.generation,
          expiresAt: lease.expires_at,
          workerId: lease.worker_id,
          workerIncarnationId: lease.worker_incarnation_id,
        },
        daemon: {
          crash: run.fixture.crash,
          snapshot: run.fixture.daemonProcessSnapshot,
        },
        ownerEvidence: {
          executionId: targetExecutionId,
          processId: owner.pid,
          workerId: lease.worker_id,
          workerIncarnationId: lease.worker_incarnation_id,
          generation: lease.generation,
          provenance: "DurableGenerationWithStableIncarnation",
        },
      });
      expect(expired.before.generation).toBe(lease.generation);
      expect(expired.after.generation).toBe(lease.generation);
      expect(Date.parse(expired.after.expires_at)).toBeLessThan(Date.now());

      const recovered = await waitForResumedAction(run.snapshot, "Consumed");
      expect(recovered.approval).toMatchObject({
        state: "Consumed",
        revision: run.revision + 2,
        consumed_by: run.before.approval?.tool_invocation_id,
        execution_id: run.before.approval?.execution_id,
        logical_step_no: run.before.approval?.logical_step_no,
        logical_action_id: run.before.approval?.logical_action_id,
        tool_invocation_id: run.before.approval?.tool_invocation_id,
      });
      expect(recovered.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(recovered.action?.state).toBe("Applied");
      expect(recovered.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        settlement_kind: "Success",
      });
      expect(recovered.effectCount).toBe(1);
      expect(recovered.matchingInvocationCount).toBe(1);
      expect(recovered.executionApprovalCount).toBe(1);
      expect(recovered.recoveryBinding?.recovery_binding_state).toBe("Bound");
      expect(recovered.attempt0).toMatchObject({
        attempt_no: 0,
        admission_state: "NotAdmitted",
        admission_source: "P39Claim",
        admission_time_precision: "NotAdmitted",
        binding_sha256: recovered.recoveryBinding?.recovery_binding_sha256,
      });
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });

  it.each(["before-resolution", "after-resolution"] as const)(
    "Stop %s interrupts the same public approval action after owner-exit recovery",
    async (ordering) => {
      const marker = `P38-STOP-${ordering.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
      const probes: Array<{
        readonly tag?: string;
        readonly role?: string;
        readonly boundary?: string;
        readonly executionId?: string;
        readonly invocationId?: string;
      }> = [];
      const run = await startExecutableApproval(marker, {
        firstDaemonEntry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "old",
          ...(ordering === "after-resolution"
            ? {
                ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolIntentCommit",
              }
            : {}),
        },
        onDaemonStdout: (line) => {
          try {
            const event = JSON.parse(line) as (typeof probes)[number];
            if (event.tag === "P4_FENCE_PROBE") probes.push(event);
          } catch {
            // Ordinary daemon output is diagnostic data, not a probe.
          }
        },
      });
      const gateDirectory = join(
        dirname(run.fixture.databaseFile),
        "p4-fence-gates",
      );
      mkdirSync(gateDirectory, { recursive: true });
      if (ordering === "before-resolution") {
        writeFileSync(join(gateDirectory, "old-driver.request"), "pause");
      }

      let oldOwnerPause: (typeof probes)[number] | undefined;
      if (ordering === "after-resolution") {
        const firstNewProbe = probes.length;
        await resolveApproval(
          run.client,
          run.project.projectId,
          run.approvalId,
          run.revision,
          "Approve",
        );
        oldOwnerPause = await waitForPublic(
          async () =>
            probes
              .slice(firstNewProbe)
              .find(
                (event) =>
                  event.role === "old" &&
                  event.boundary === "AH7AfterToolIntentCommit",
              ),
          (event) => event !== undefined,
          60_000,
        );
        if (oldOwnerPause === undefined) {
          throw new Error("P38 post-resolution pre-effect pause was absent");
        }
        expect(oldOwnerPause.executionId).toBe(
          run.before.approval?.execution_id,
        );
        expect(oldOwnerPause.invocationId).toBe(
          run.before.approval?.tool_invocation_id,
        );
      }

      const firstNewProbe = probes.length;
      const stopResponse = await run.client.command(
        run.project.projectId,
        "StopExecution",
        { executionId: run.before.approval?.execution_id },
      );
      expect(stopResponse).toMatchObject({ body: { resolution: "Committed" } });

      if (ordering === "before-resolution") {
        oldOwnerPause = await waitForPublic(
          async () =>
            probes
              .slice(firstNewProbe)
              .find(
                (event) =>
                  event.role === "old" &&
                  event.boundary === "AH10AfterLeaseAcquired",
              ),
          (event) => event !== undefined,
          60_000,
        );
        if (oldOwnerPause === undefined) {
          throw new Error("P38 pre-resolution stopped-owner pause was absent");
        }
        expect(oldOwnerPause.executionId).toBe(
          run.before.approval?.execution_id,
        );
      }

      const beforeOwnerExit = run.snapshot();
      expect(beforeOwnerExit.execution?.stop_requested_at).not.toBeNull();
      expect(beforeOwnerExit.execution?.settlement_kind).toBeNull();
      expect(beforeOwnerExit.approval).toMatchObject(
        ordering === "before-resolution"
          ? {
              state: "Cancelled",
              revision: run.revision + 1,
              cancellation_reason: "StopRequested",
            }
          : {
              state: "Consumed",
              revision: run.revision + 2,
              consumed_by: run.before.approval?.tool_invocation_id,
            },
      );
      expect(beforeOwnerExit.inboxConsumedAt).not.toBeNull();
      expect(beforeOwnerExit.executionStopEventCount).toBe(1);
      const resolutionEvents = beforeOwnerExit.approvalEvents
        .filter((event) => event.event_type === "ExecutableApprovalResolved")
        .map(
          (event) =>
            JSON.parse(event.payload_json) as {
              readonly resolution?: string;
              readonly reasonCode?: string;
              readonly toolInvocationId?: string;
            },
        );
      expect(resolutionEvents).toHaveLength(1);
      expect(resolutionEvents[0]).toMatchObject(
        ordering === "before-resolution"
          ? { resolution: "Cancelled", reasonCode: "StopRequested" }
          : {
              resolution: "Approved",
              toolInvocationId: run.before.approval?.tool_invocation_id,
            },
      );
      expect(beforeOwnerExit.effectCount).toBe(0);
      if (ordering === "before-resolution") {
        expect(beforeOwnerExit.invocation).toBeUndefined();
      } else {
        expect(beforeOwnerExit.invocation).toMatchObject({
          invocation_id: run.before.approval?.tool_invocation_id,
          effect_admission_state: "NotAdmitted",
          settlement_kind: null,
        });
      }

      const expired = await expireStoppedInitialOwner(run);
      expect(expired.before.generation).toBe(expired.after.generation);
      expect(Date.parse(expired.after.expires_at)).toBeLessThan(Date.now());
      const peerEvents: Array<Record<string, unknown>> = [];
      const peer = await run.fixture.startAdditionalDaemon({
        entry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_FENCE_TRACE_NEW: "1",
        },
        onStdout: (line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.tag === "P4_FENCE_PROBE") peerEvents.push(event);
          } catch {
            // Ordinary daemon output is diagnostic data, not a probe.
          }
        },
      });
      try {
        const recovered = await waitForPublic(
          async () => run.snapshot(),
          (snapshot) =>
            snapshot.execution?.settlement_kind === "Interrupted" &&
            (ordering === "before-resolution"
              ? snapshot.invocation === undefined
              : snapshot.invocation?.settlement_kind === "Interrupted") &&
            snapshot.effectCount === 0,
          60_000,
        ).catch((error: unknown) => {
          throw new Error(
            `${String(error)}; peerEvents=${JSON.stringify(peerEvents)}; peerErrors=${JSON.stringify(peer.daemonErrors)}`,
          );
        });
        expect(
          JSON.parse(recovered.execution?.settlement_json ?? "{}"),
        ).toMatchObject({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
        expect(recovered.approval?.logical_action_id).toBe(
          run.before.approval?.logical_action_id,
        );
        expect(recovered.step?.provider_turn_id).toBe(
          run.before.step?.provider_turn_id,
        );
        expect(recovered.action?.state).not.toBe("Applied");
        expect(recovered.executionStopEventCount).toBe(1);
        expect(recovered.inboxConsumedAt).not.toBeNull();
        expect(
          recovered.approvalEvents.filter(
            (event) => event.event_type === "ExecutableApprovalResolved",
          ),
        ).toHaveLength(1);
        expect(recovered.effectCount).toBe(0);
        if (ordering === "after-resolution") {
          expect(recovered.invocation).toMatchObject({
            invocation_id: run.before.approval?.tool_invocation_id,
            approval_id: run.approvalId,
            effect_admission_state: "NotAdmitted",
            settlement_kind: "Interrupted",
          });
          expect(recovered.recoveryBinding).toMatchObject({
            recovery_binding_state: "Bound",
          });
          expect(recovered.attempt0).toMatchObject({
            attempt_no: 0,
            admission_state: "NotAdmitted",
            admission_source: "P39Claim",
          });
        }
        expect(run.fixture.daemonErrors).toEqual([]);
        expect(peer.daemonErrors).toEqual([]);
      } finally {
        await peer.crash();
      }
    },
  );

  it("keeps StopRequested as the Execution cause when a P4 Denied winner committed first", async () => {
    const marker = `P38-STOP-DENIED-WINNER-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
      readonly outcomeTag?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      firstDaemonEntry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY:
          "P4ExecutableToolRuntimeOutcomeDenied",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "P4_FENCE_PROBE") probes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });
    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Reject",
    );
    const deniedPause = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "P4ExecutableToolRuntimeOutcome" &&
            event.outcomeTag === "Denied",
        ),
      (event) => event !== undefined,
      60_000,
    );
    if (deniedPause === undefined) {
      throw new Error("P38 committed-Denied pre-AgentLoop pause was absent");
    }
    expect(deniedPause.executionId).toBe(run.before.approval?.execution_id);
    expect(deniedPause.invocationId).toBe(
      run.before.approval?.tool_invocation_id,
    );
    const deniedBeforeStop = run.snapshot();
    expect(deniedBeforeStop.execution?.settlement_kind).toBeNull();
    expect(deniedBeforeStop.approval).toMatchObject({
      state: "Rejected",
      revision: run.revision + 1,
    });
    expect(deniedBeforeStop.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
    });
    expect(deniedBeforeStop.effectCount).toBe(0);

    const stopResponse = await run.client.command(
      run.project.projectId,
      "StopExecution",
      { executionId: run.before.approval?.execution_id },
    );
    expect(stopResponse).toMatchObject({ body: { resolution: "Committed" } });
    const beforeOwnerExit = run.snapshot();
    expect(beforeOwnerExit.execution?.stop_requested_at).not.toBeNull();
    expect(beforeOwnerExit.execution?.settlement_kind).toBeNull();
    expect(beforeOwnerExit.invocation).toEqual(deniedBeforeStop.invocation);
    expect(beforeOwnerExit.executionStopEventCount).toBe(1);
    expect(
      beforeOwnerExit.approvalEvents.filter(
        (event) => event.event_type === "ExecutableApprovalResolved",
      ),
    ).toHaveLength(1);

    const expired = await expireStoppedInitialOwner(run);
    expect(expired.before.generation).toBe(expired.after.generation);
    expect(Date.parse(expired.after.expires_at)).toBeLessThan(Date.now());
    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
    });
    try {
      const recovered = await waitForPublic(
        async () => run.snapshot(),
        (snapshot) =>
          snapshot.execution?.settlement_kind === "Interrupted" &&
          snapshot.action !== undefined &&
          snapshot.action.state !== "Applied" &&
          snapshot.effectCount === 0,
        60_000,
      );
      expect(
        JSON.parse(recovered.execution?.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      });
      expect(recovered.approval).toEqual(deniedBeforeStop.approval);
      expect(recovered.invocation).toEqual(deniedBeforeStop.invocation);
      expect(recovered.action?.state).toMatch(/^(Pending|TerminalRejected)$/u);
      expect(recovered.approval?.logical_action_id).toBe(
        run.before.approval?.logical_action_id,
      );
      expect(recovered.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(recovered.executionStopEventCount).toBe(1);
      expect(
        recovered.approvalEvents.filter(
          (event) => event.event_type === "ExecutableApprovalResolved",
        ),
      ).toHaveLength(1);
      expect(recovered.inboxConsumedAt).not.toBeNull();
      expect(recovered.effectCount).toBe(0);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });

  it("reuses a committed same-Step approval claim after a process crash before effect admission", async () => {
    const marker = `P38-CLAIM-CRASH-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      firstDaemonEntry: p4FenceChild,
      preserveDirectoryOnStop: true,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolIntentCommit",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "P4_FENCE_PROBE") probes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });

    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );

    const probe = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolIntentCommit",
        ),
      (event) => event !== undefined,
      60_000,
    );
    if (probe === undefined) {
      throw new Error("P38 claim-commit crash probe was absent");
    }
    expect(probe.executionId).toBe(run.before.approval?.execution_id);
    expect(probe.invocationId).toBe(run.before.approval?.tool_invocation_id);

    const claimed = run.snapshot();
    expect(claimed.approval).toMatchObject({
      state: "Consumed",
      revision: run.revision + 2,
      consumed_by: run.before.approval?.tool_invocation_id,
    });
    expect(claimed.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      effect_admission_state: "NotAdmitted",
      settlement_kind: null,
    });
    expect(claimed.action?.state).toBe("Pending");
    expect(claimed.effectCount).toBe(0);
    expect(claimed.matchingInvocationCount).toBe(1);
    expect(claimed.executionApprovalCount).toBe(1);
    expect(claimed.recoveryBinding).toMatchObject({
      recovery_binding_state: "Bound",
      binding_sha256: claimed.recoveryBinding?.recovery_binding_sha256,
    });
    expect(claimed.recoveryBinding?.recovery_binding_sha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(
      JSON.parse(claimed.recoveryBinding?.canonical_binding_json ?? "{}"),
    ).toMatchObject({
      bindingVersion: 1,
      executionId: run.before.approval?.execution_id,
      invocationId: run.before.approval?.tool_invocation_id,
      providerTurnId: run.before.step?.provider_turn_id,
      logicalStepNo: run.before.approval?.logical_step_no,
      repairAttempt: run.before.approval?.repair_attempt,
      logicalActionId: run.before.approval?.logical_action_id,
      actionIndex: run.before.approval?.action_index,
      callRef: run.before.approval?.call_ref,
      approvalId: run.approvalId,
      approvalPreConsumeRevision: run.revision + 1,
      approvalConsumedRevision: run.revision + 2,
      approvalConsumedBy: run.before.approval?.tool_invocation_id,
    });
    expect(claimed.attempt0).toMatchObject({
      attempt_no: 0,
      admission_state: "NotAdmitted",
      admission_source: "P39Claim",
      admission_time_precision: "NotAdmitted",
      binding_sha256: claimed.recoveryBinding?.recovery_binding_sha256,
    });

    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
    });
    try {
      await run.fixture.crash();
      await run.fixture.restart({
        entry: p4FenceChild,
        daemonEnvironment: { ARBOR_P4_FENCE_ROLE: "new" },
      });

      const recovered = await waitForResumedAction(run.snapshot, "Consumed");
      expect(recovered.approval).toMatchObject({
        state: "Consumed",
        revision: run.revision + 2,
        consumed_by: run.before.approval?.tool_invocation_id,
      });
      expect(recovered.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        effect_admission_state: "MayHaveStarted",
        settlement_kind: "Success",
      });
      expect(recovered.step?.provider_turn_id).toBe(
        run.before.step?.provider_turn_id,
      );
      expect(recovered.effectCount).toBe(1);
      expect(recovered.matchingInvocationCount).toBe(1);
      expect(recovered.executionApprovalCount).toBe(1);
      expect(recovered.recoveryBinding).toEqual(claimed.recoveryBinding);
      expect(recovered.attempt0).toEqual(claimed.attempt0);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });

  it("keeps the consumed approval bound after a crash following a non-idempotent effect", async () => {
    const marker = `P38-EFFECT-CRASH-${crypto.randomUUID().slice(0, 8)}`;
    const probes: Array<{
      readonly tag?: string;
      readonly role?: string;
      readonly boundary?: string;
      readonly executionId?: string;
      readonly invocationId?: string;
    }> = [];
    const run = await startExecutableApproval(marker, {
      firstDaemonEntry: p4FenceChild,
      preserveDirectoryOnStop: true,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        ARBOR_P4_FENCE_ADMISSION_BOUNDARY: "AH7AfterToolEffectBeforeSettlement",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "P4_FENCE_PROBE") probes.push(event);
        } catch {
          // Ordinary daemon output is diagnostic data, not a probe.
        }
      },
    });

    await resolveApproval(
      run.client,
      run.project.projectId,
      run.approvalId,
      run.revision,
      "Approve",
    );
    const probe = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolEffectBeforeSettlement",
        ),
      (event) => event !== undefined,
      60_000,
    );
    if (probe === undefined) {
      throw new Error("P38 post-effect crash probe was absent");
    }
    expect(probe.executionId).toBe(run.before.approval?.execution_id);
    expect(probe.invocationId).toBe(run.before.approval?.tool_invocation_id);

    const afterEffect = run.snapshot();
    expect(afterEffect.approval).toMatchObject({
      state: "Consumed",
      side_effect_semantics: "NonIdempotent",
      revision: run.revision + 2,
      consumed_by: run.before.approval?.tool_invocation_id,
    });
    expect(afterEffect.invocation).toMatchObject({
      invocation_id: run.before.approval?.tool_invocation_id,
      approval_id: run.approvalId,
      effect_admission_state: "MayHaveStarted",
      settlement_kind: null,
    });
    expect(afterEffect.effectCount).toBe(1);
    expect(afterEffect.matchingInvocationCount).toBe(1);
    expect(afterEffect.executionApprovalCount).toBe(1);

    const peer = await run.fixture.startAdditionalDaemon({
      entry: p4FenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "new",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
      },
    });
    try {
      await run.fixture.crash();
      await run.fixture.restart({
        entry: p4FenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        },
      });
      const recovered = await waitForPublic(
        async () => run.snapshot(),
        (snapshot) =>
          snapshot.approval?.state === "Consumed" &&
          snapshot.invocation?.settlement_kind === "OutcomeUnknown" &&
          snapshot.effectCount === 1 &&
          snapshot.matchingInvocationCount === 1 &&
          snapshot.executionApprovalCount === 1,
        60_000,
      );
      expect(recovered.approval).toMatchObject({
        state: "Consumed",
        revision: run.revision + 2,
        consumed_by: run.before.approval?.tool_invocation_id,
      });
      expect(recovered.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        effect_admission_state: "MayHaveStarted",
        settlement_kind: "OutcomeUnknown",
      });
      expect(
        probes.filter(
          (event) => event.boundary === "AH7AfterToolEffectBeforeSettlement",
        ),
      ).toHaveLength(1);
      expect(run.fixture.daemonErrors).toEqual([]);
      expect(peer.daemonErrors).toEqual([]);
    } finally {
      await peer.crash();
    }
  });
});
