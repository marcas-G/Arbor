import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  readonly consumed_at: string | null;
  readonly consumed_by: string | null;
}

interface ApprovalSnapshot {
  readonly approval: ExecutableApprovalRow | undefined;
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
      }
    | undefined;
  readonly effectCount: number;
  readonly matchingInvocationCount: number;
}

const fixtures: ProductionFixture[] = [];
const EXECUTABLE_APPROVAL_ENTRY_KEY = /^eap:(.+):(\d+)$/u;
const p4FenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);

interface ApprovalFixtureQualificationOptions {
  readonly firstDaemonEntry?: string;
  readonly daemonEnvironment?: Readonly<Record<string, string>>;
  readonly onDaemonStdout?: (line: string) => void;
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
      ? `Add-Content -LiteralPath '${effectLog}' -Value '${marker}'; if (Test-Path -LiteralPath 'proof.txt') { mv -LiteralPath 'proof.txt' -Destination '${destination}' }`
      : `printf '%s\\n' '${marker}' >> '${effectLog}'; if [ -f proof.txt ]; then mv proof.txt '${destination}'; fi`;

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
    expiresAt: null,
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

  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          EXECUTABLE_APPROVAL_ENTRY_KEY.test(entry.entryKey),
      ),
    60_000,
  );
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      EXECUTABLE_APPROVAL_ENTRY_KEY.test(candidate.entryKey),
  );
  const match =
    entry === undefined
      ? null
      : EXECUTABLE_APPROVAL_ENTRY_KEY.exec(entry.entryKey);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `public Inbox exposed no exact Executable approval for ${marker}`,
    );
  }

  const approvalId = match[1];
  const revision = Number(match[2]);
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
                revision, consumed_at,
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
                      settlement_kind FROM tool_invocations
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
    return {
      approval,
      step,
      action,
      invocation,
      effectCount,
      matchingInvocationCount,
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
          snapshot.matchingInvocationCount === 1,
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
