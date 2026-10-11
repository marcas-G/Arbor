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
  readonly state: string;
  readonly revision: number;
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
        readonly settlement_kind: string | null;
      }
    | undefined;
  readonly effectCount: number;
}

const fixtures: ProductionFixture[] = [];
const EXECUTABLE_APPROVAL_ENTRY_KEY = /^eap:(.+):(\d+)$/u;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const startExecutableApproval = async (marker: string) => {
  const destination = `p38-moved-${marker}.txt`;
  const effectLog = `p38-effects-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${marker}'; mv -LiteralPath 'proof.txt' -Destination '${destination}' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${marker}' >> '${effectLog}' && mv proof.txt '${destination}'; fi`;

  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
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
                call_ref, tool_invocation_id, state, revision
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
              `SELECT invocation_id, approval_id, settlement_kind FROM tool_invocations
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
    return { approval, step, action, invocation, effectCount };
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
) =>
  waitForPublic(
    async () => snapshot(),
    (value) =>
      value.approval?.state === terminalState &&
      value.action?.state === "Applied" &&
      value.invocation?.settlement_kind ===
        (terminalState === "Consumed" ? "Success" : "Denied"),
    45_000,
  );

describe("pending P38 public Executable approval qualification", () => {
  it.skip("approves over the public API and resumes the same Execution/AgentLoopStep", async () => {
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

  it.skip.each(["Reject", "Expire"] as const)(
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
      expect(resumed.action?.state).toBe("Applied");
      expect(resumed.invocation).toMatchObject({
        invocation_id: run.before.approval?.tool_invocation_id,
        approval_id: run.approvalId,
        settlement_kind: "Denied",
      });
      expect(resumed.effectCount).toBe(0);
    },
  );

  it.skip("survives restart with two daemons and consumes one approval/effect", async () => {
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
});
