import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

interface ApprovalRow {
  readonly approval_id: string;
  readonly execution_id: string;
  readonly state: string;
  readonly revision: number;
  readonly consumed_at: string | null;
  readonly consumed_by: string | null;
  readonly route_kind: string;
}

interface CommandRow {
  readonly command_id: string;
  readonly project_id: string;
  readonly resolution: string;
  readonly result_json: string | null;
}

interface WorkRow {
  readonly work_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly lifecycle: string;
}

interface WorkAssignedRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly payload_json: string;
}

interface ActionRow {
  readonly execution_id: string;
  readonly provider_turn_id: string;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly action_kind: string;
  readonly state: string;
}

const fixtures: ProductionFixture[] = [];
const ah10ProcessChild = resolve(
  "tests/functional/support/ah10-process-child.mjs",
);

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const readRows = (databaseFile: string, approvalId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      approvals: db
        .prepare(
          `SELECT approval_id, execution_id, state, revision, consumed_at,
                  consumed_by, route_kind
             FROM action_approvals WHERE approval_id = ?`,
        )
        .all(approvalId) as unknown as ApprovalRow[],
      commands: db
        .prepare(
          `SELECT command_id, project_id, resolution, result_json
             FROM commands ORDER BY command_id`,
        )
        .all() as unknown as CommandRow[],
      works: db
        .prepare(
          `SELECT work_id, project_id, workspace_id, objective, lifecycle
             FROM works ORDER BY work_id`,
        )
        .all() as unknown as WorkRow[],
      events: db
        .prepare(
          `SELECT event_id, event_type, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events WHERE event_type = 'WorkAssigned'
            ORDER BY sequence`,
        )
        .all() as unknown as WorkAssignedRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.call_ref, a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            WHERE a.action_kind = 'assign_work'
            ORDER BY a.execution_id, a.action_index`,
        )
        .all() as unknown as ActionRow[],
    };
  } finally {
    db.close();
  }
};

const readBootstrapRows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      userVersion: Number(
        db.prepare("PRAGMA user_version").get()?.user_version ?? -1,
      ),
      executions: db
        .prepare(
          `SELECT execution_id, episode_kind, episode_ref, settlement_kind
             FROM executions ORDER BY admitted_at`,
        )
        .all(),
      messages: db
        .prepare(
          `SELECT message_id, state, claimed_by_execution_id
             FROM human_messages ORDER BY created_at`,
        )
        .all(),
      steps: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, state,
                  next_action_index, provider_turn_id
             FROM agent_loop_steps ORDER BY execution_id, logical_step_no,
                  repair_attempt`,
        )
        .all(),
      actions: db
        .prepare(
          `SELECT execution_id, action_index, action_kind, state, call_ref,
                  logical_action_id
             FROM agent_loop_step_actions ORDER BY execution_id, action_index`,
        )
        .all(),
      approvals: db
        .prepare(
          `SELECT approval_id, route_kind, state, revision, consumed_at,
                  consumed_by
             FROM action_approvals ORDER BY approval_id`,
        )
        .all(),
    };
  } finally {
    db.close();
  }
};

describe("P38 CAPA current-Workspace AssignWork recovery", () => {
  it("commits the Work, exact approval consumer CommandId and receipt once", async () => {
    const marker = `P38-CAPA-${crypto.randomUUID().slice(0, 8)}`;
    const objective = `Admit the exact approved root Work ${marker}.`;
    let providerRequests = 0;
    let assignWorkCalls = 0;
    const probes: Array<{
      readonly tag: string;
      readonly boundary?: string;
      readonly actionKind?: string;
      readonly executionId?: string;
      readonly logicalActionId?: string;
      readonly providerTurnId?: string;
      readonly callRef?: string;
    }> = [];
    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      firstDaemonEntry: ah10ProcessChild,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        // The helper pauses by default when this filter is absent. This
        // sentinel matches no registered action and leaves only our return gate.
        ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "assign_work",
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as (typeof probes)[number];
          if (event.tag === "AH10_PROBE") probes.push(event);
        } catch {
          // Keep non-probe daemon output out of the test signal.
        }
      },
      reply: (call) => {
        providerRequests += 1;
        const context = JSON.stringify(call.messages);
        if (!context.includes(marker)) {
          return { _tag: "HttpError", status: 422 };
        }
        const names = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (names.has("assign_work") && !names.has("claim_completion")) {
          if (
            call.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content?.includes("WorkAssigned("),
            )
          ) {
            return { _tag: "Text", text: `Admitted ${marker}.` };
          }
          assignWorkCalls += 1;
          return {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              objective,
              why: "admit the human-approved root Work",
              constraints: ["preserve the approved action"],
              completionExpectation: "exactly one Work is admitted",
              verificationMission: {
                goal: `Verify root Work ${marker}`,
                criteria: [
                  {
                    criterionId: "one-work",
                    requirement: `one Work with marker ${marker} is committed`,
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
              reason: "P38 current Workspace approval regression",
            },
          };
        }
        return { _tag: "Text", text: `Observed ${marker}.` };
      },
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `P38 CAPA ${marker}`,
      { resourceSelection: "Profile" },
    );
    await submitHumanMessage(
      client,
      project,
      `Please create the Work ${marker}: ${objective}`,
    );
    const approval = await waitForApproval(client, project, marker).catch(
      async (error: unknown) => {
        const [inbox, currentWork] = await Promise.all([
          client
            .view("inbox-view", { workspaceId: project.rootWorkspaceId })
            .catch((viewError: unknown) => String(viewError)),
          client
            .view("current-work", { workspaceId: project.rootWorkspaceId })
            .catch((viewError: unknown) => String(viewError)),
        ]);
        throw new Error(
          `P38 CAPA seed did not produce approval: ${error instanceof Error ? error.message : String(error)}; ` +
            JSON.stringify({
              providerRequests,
              providerCalls: fixture.providerCalls,
              daemonErrors: fixture.daemonErrors,
              inbox,
              currentWork,
              rows: readBootstrapRows(fixture.databaseFile),
            }),
        );
      },
    );
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "Approve this exact current-Workspace AssignWork action",
    });

    const actionReturn = await waitForPublic(
      async () =>
        probes.find(
          (event) =>
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.actionKind === "assign_work",
        ),
      (event) => event !== undefined,
    );
    if (
      actionReturn?.executionId === undefined ||
      actionReturn.logicalActionId === undefined ||
      actionReturn.providerTurnId === undefined ||
      actionReturn.callRef === undefined
    ) {
      throw new Error(
        `P38 post-Command probe omitted pinned action identity: ${JSON.stringify(actionReturn)}`,
      );
    }

    const beforeRestart = readRows(fixture.databaseFile, approval.approvalId);
    const approvalBeforeRestart = beforeRestart.approvals[0];
    const workBeforeRestart = beforeRestart.works.filter(
      (work) => work.objective === objective,
    );
    const eventBeforeRestart = beforeRestart.events.filter(
      (event) => JSON.parse(event.payload_json).objective === objective,
    );
    const actionBeforeRestart = beforeRestart.actions.filter(
      (row) => row.execution_id === actionReturn.executionId,
    );
    expect(approvalBeforeRestart).toMatchObject({
      state: "Consumed",
      revision: 2,
      route_kind: "Control",
    });
    expect(approvalBeforeRestart?.consumed_by).toMatch(/^cmd_/u);
    expect(workBeforeRestart).toHaveLength(1);
    expect(eventBeforeRestart).toHaveLength(1);
    expect(eventBeforeRestart[0]?.caused_by_command_id).toBe(
      approvalBeforeRestart?.consumed_by,
    );
    expect(
      beforeRestart.commands.filter(
        (command) => command.command_id === approvalBeforeRestart?.consumed_by,
      ),
    ).toMatchObject([{ resolution: "Committed" }]);
    expect(actionBeforeRestart).toHaveLength(1);
    expect(actionBeforeRestart[0]).toMatchObject({
      logical_action_id: actionReturn.logicalActionId,
      provider_turn_id: actionReturn.providerTurnId,
      call_ref: actionReturn.callRef,
      action_kind: "assign_work",
      state: "Pending",
    });
    expect(assignWorkCalls).toBe(1);

    await fixture.crash();
    await fixture.restart({
      entry: ah10ProcessChild,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
    });

    const completed = await waitForPublic(
      async () => readRows(fixture.databaseFile, approval.approvalId),
      (rows) =>
        rows.approvals[0]?.state === "Consumed" &&
        rows.works.filter((work) => work.objective === objective).length ===
          1 &&
        rows.actions.some(
          (action) =>
            action.action_kind === "assign_work" && action.state === "Applied",
        ),
      60_000,
    );

    const controlApproval = completed.approvals[0];
    const assignedWork = completed.works.filter(
      (work) => work.objective === objective,
    );
    const assignedEvents = completed.events.filter(
      (event) => JSON.parse(event.payload_json).objective === objective,
    );
    const action = completed.actions.find(
      (row) => row.execution_id === controlApproval?.execution_id,
    );
    expect(controlApproval).toMatchObject({
      approval_id: approval.approvalId,
      state: "Consumed",
      revision: 2,
      route_kind: "Control",
    });
    expect(controlApproval?.consumed_at).not.toBeNull();
    expect(controlApproval?.consumed_by).toMatch(/^cmd_/u);
    expect(assignedWork).toHaveLength(1);
    expect(assignedWork[0]).toMatchObject({
      project_id: project.projectId,
      workspace_id: project.rootWorkspaceId,
      lifecycle: "Open",
      objective,
    });
    expect(assignedEvents).toHaveLength(1);
    expect(assignedEvents[0]?.caused_by_command_id).toBe(
      controlApproval?.consumed_by,
    );
    const commandReceipt = completed.commands.filter(
      (command) => command.command_id === controlApproval?.consumed_by,
    );
    expect(commandReceipt).toMatchObject([
      {
        command_id: controlApproval?.consumed_by,
        project_id: project.projectId,
        resolution: "Committed",
      },
    ]);
    expect(JSON.parse(commandReceipt[0]?.result_json ?? "null")).toMatchObject({
      workspaceId: project.rootWorkspaceId,
      workId: assignedWork[0]?.work_id,
    });
    expect(action).toMatchObject({
      action_kind: "assign_work",
      state: "Applied",
      logical_action_id: actionReturn.logicalActionId,
      provider_turn_id: actionReturn.providerTurnId,
      call_ref: actionReturn.callRef,
    });
    expect(action?.logical_action_id).toMatch(/^lac_/u);
    expect(assignWorkCalls).toBe(1);
    expect(providerRequests).toBeGreaterThanOrEqual(1);
  });
});
