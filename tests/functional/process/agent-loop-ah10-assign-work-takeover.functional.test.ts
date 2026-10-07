import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  waitForPublic,
} from "../support/public-client.js";

interface Ah10Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
}

interface CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface WorkRow {
  readonly work_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly lifecycle: string;
  readonly revision: number;
}

interface WorkAssignedEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_ref: string;
  readonly caused_by_command_id: string | null;
  readonly payload_json: string;
}

const fixtures: ProductionFixture[] = [];
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const pushProbe = (events: Ah10Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Ah10Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Daemon logs are retained by the fixture for failure diagnostics.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

const readRows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all() as Array<{
        execution_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands",
        )
        .all() as unknown as CommandRow[],
      works: db
        .prepare(
          `SELECT work_id, project_id, workspace_id, objective, lifecycle, revision
             FROM works ORDER BY created_at, work_id`,
        )
        .all() as unknown as WorkRow[],
      workAssignedEvents: db
        .prepare(
          `SELECT event_id, event_type, aggregate_ref, caused_by_command_id, payload_json
             FROM domain_events WHERE event_type = 'WorkAssigned'
            ORDER BY sequence`,
        )
        .all() as unknown as WorkAssignedEventRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.action_index, a.observation_source_ref, a.call_ref,
                  a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            ORDER BY a.action_index`,
        )
        .all() as Array<{
        execution_id: string;
        provider_turn_id: string;
        logical_action_id: string;
        action_index: number;
        observation_source_ref: string | null;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
      actionObservations: db
        .prepare(
          `SELECT se.source_ref, se.payload_json
             FROM session_entries se
            WHERE se.source_kind = 'AgentLoopAction'
              AND se.entry_kind = 'Observation'
            ORDER BY se.sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
      providerAttempts: db
        .prepare(
          `SELECT provider_turn_id, attempt_no, outcome, settled_at
             FROM provider_attempts ORDER BY provider_turn_id, attempt_no`,
        )
        .all() as Array<{
        provider_turn_id: string;
        attempt_no: number;
        outcome: string;
        settled_at: string | null;
      }>,
    };
  } finally {
    db.close();
  }
};

const fencedReceipts = (rows: ReturnType<typeof readRows>) =>
  rows.commands.filter(
    (command) =>
      command.resolution === "TerminalRejected" &&
      command.terminal_error_json?.includes("FencingRejected"),
  );

const targetWorks = (rows: ReturnType<typeof readRows>, objective: string) =>
  rows.works.filter((work) => work.objective === objective);

describe("AH10 real daemon AssignWork generation takeover", () => {
  it.each(["before", "after"] as const)(
    "takes over current-Workspace AssignWork after killing gen0 %s its FencingRejected receipt commits",
    async (crashSide) => {
      const marker = `AH10-assign-work-${crypto.randomUUID().slice(0, 8)}`;
      const sourceObjective = `Exercise AssignWork takeover ${marker}.`;
      const targetObjective = `Assigned Work from AH10 ${marker}.`;
      const events: Ah10Probe[] = [];
      const actionProviderCalls: number[] = [];
      const fixture = await startProductionFixture({
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          if (!context.includes(marker)) {
            return { _tag: "HttpError", status: 422 };
          }
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (!available.has("assign_work")) {
            return { _tag: "HttpError", status: 422 };
          }
          if (context.includes("WorkAssigned(")) {
            return { _tag: "Text", text: `Assigned ${marker}.` };
          }
          actionProviderCalls.push(index);
          return {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              objective: targetObjective,
              why: "qualify generation takeover of the canonical AssignWork command",
              constraints: ["preserve the single pinned action"],
              completionExpectation: "one WorkAssigned fact is committed",
              verificationMission: {
                goal: `Verify assigned Work ${marker}`,
                criteria: [
                  {
                    criterionId: "ah10-assigned-work-created",
                    requirement: `one Work is assigned for ${marker}`,
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
              reason: "AH10 receipt-first process qualification",
            },
          };
        },
        firstDaemonEntry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
        },
        onDaemonStdout: (line) => pushProbe(events, line),
      });
      fixtures.push(fixture);
      mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH10 AssignWork generation takeover",
      );

      // The public, exact-bound WorkspaceAgent grant satisfies CAPA for this
      // WorkspaceWork action. The model omits targetWorkspaceRef, so both the
      // grant and the action target are the current root Workspace.
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "core.control.assign-work",
        target: project.rootWorkspaceId,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });

      const sourceWorkId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId: sourceWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: sourceObjective,
        why: "host the WorkspaceWork episode that exercises AssignWork",
        constraints: [],
        completionExpectation: "the model assigns one additional Work",
        verificationMission: {
          goal: `Verify AssignWork action ${marker}`,
          criteria: [
            {
              criterionId: "ah10-source-work-open",
              requirement: "the source Work remains open during takeover",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "AH10 process fixture" },
        revision: 0,
      });

      const oldAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "assign_work" &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      if (oldAction === undefined) {
        throw new Error("AH10 old AssignWork ActionIntent probe was absent");
      }
      const providerTurnId = oldAction.providerTurnId;
      const logicalActionId = oldAction.logicalActionId;
      const callRef = oldAction.callRef;
      if (
        providerTurnId === undefined ||
        logicalActionId === undefined ||
        callRef === undefined
      ) {
        throw new Error("AH10 AssignWork ActionIntent omitted pinned identity");
      }
      expect(actionProviderCalls).toHaveLength(1);

      const oldLeasePause = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeLeaseRenewal" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        20_000,
      );
      if (oldLeasePause === undefined) {
        throw new Error("AH10 old AssignWork lease pause probe was absent");
      }
      expect(oldLeasePause.fencingGeneration).toBe(0);
      const oldLease = readRows(fixture.databaseFile).leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      expect(oldLease?.generation).toBe(0);
      await waitForPublic(
        async () =>
          readRows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const newLease = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH10 gen1 did not acquire AssignWork lease: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(fixture.databaseFile))}; daemon=${newDaemon.daemonErrors.join(" | ")}`,
        );
      });
      if (newLease === undefined) {
        throw new Error("AH10 new AssignWork owner did not acquire the lease");
      }
      expect(newLease.fencingGeneration).toBe(1);
      const newAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "assign_work" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      if (newAction === undefined) {
        throw new Error("AH10 new AssignWork ActionIntent probe was absent");
      }
      expect(newAction.providerTurnId).toBe(providerTurnId);
      expect(newAction.callRef).toBe(callRef);
      expect(newAction.logicalActionId).toBe(logicalActionId);
      expect(actionProviderCalls).toHaveLength(1);

      releaseGate(fixture, "old", "action-intent");
      let oldRejectedCommandId: string;
      if (crashSide === "before") {
        const beforeCommit = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeFencedReceiptCommit" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          15_000,
        );
        if (
          beforeCommit === undefined ||
          beforeCommit.commandId === undefined
        ) {
          throw new Error("AH10 pre-commit AssignWork fence probe was absent");
        }
        oldRejectedCommandId = beforeCommit.commandId;
        expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        const beforeKill = readRows(fixture.databaseFile);
        expect(fencedReceipts(beforeKill)).toHaveLength(0);
        expect(targetWorks(beforeKill, targetObjective)).toHaveLength(0);
        expect(
          beforeKill.workAssignedEvents.filter(
            (event) =>
              JSON.parse(event.payload_json).objective === targetObjective,
          ),
        ).toHaveLength(0);
        expect(
          beforeKill.commands.some(
            (command) => command.command_id === oldRejectedCommandId,
          ),
        ).toBe(false);
      } else {
        const rejected = await waitForPublic(
          async () => fencedReceipts(readRows(fixture.databaseFile)),
          (rows) => rows.length === 1,
          15_000,
        );
        oldRejectedCommandId = rejected[0]?.command_id ?? "";
        expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        expect(
          targetWorks(readRows(fixture.databaseFile), targetObjective),
        ).toHaveLength(0);
        expect(
          readRows(fixture.databaseFile).workAssignedEvents.filter(
            (event) =>
              JSON.parse(event.payload_json).objective === targetObjective,
          ),
        ).toHaveLength(0);
      }

      await fixture.crash();
      if (crashSide === "before") {
        const afterKill = readRows(fixture.databaseFile);
        expect(fencedReceipts(afterKill)).toHaveLength(0);
        expect(targetWorks(afterKill, targetObjective)).toHaveLength(0);
        expect(
          afterKill.workAssignedEvents.filter(
            (event) =>
              JSON.parse(event.payload_json).objective === targetObjective,
          ),
        ).toHaveLength(0);
        expect(
          afterKill.commands.some(
            (command) => command.command_id === oldRejectedCommandId,
          ),
        ).toBe(false);
      }

      releaseGate(fixture, "new", "action-intent");
      const completed = await waitForPublic(
        async () => readRows(fixture.databaseFile),
        (rows) =>
          targetWorks(rows, targetObjective).length === 1 &&
          rows.actions.some(
            (action) =>
              action.execution_id === oldAction.executionId &&
              action.logical_action_id === logicalActionId &&
              action.state === "Applied",
          ),
        30_000,
      );

      const assigned = targetWorks(completed, targetObjective);
      expect(assigned).toHaveLength(1);
      expect(assigned[0]).toMatchObject({
        project_id: project.projectId,
        workspace_id: project.rootWorkspaceId,
        lifecycle: "Open",
        revision: 0,
      });
      const assignedEvents = completed.workAssignedEvents.filter((event) => {
        try {
          return (
            (JSON.parse(event.payload_json) as { objective?: string })
              .objective === targetObjective
          );
        } catch {
          return false;
        }
      });
      expect(assignedEvents).toHaveLength(1);
      expect(assignedEvents[0]?.aggregate_ref).toBe(project.rootWorkspaceId);

      const committed = completed.commands.filter((command) => {
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
          return false;
        }
        try {
          const result = JSON.parse(command.result_json) as {
            workId?: string;
            workspaceId?: string;
          };
          return (
            result.workId === assigned[0]?.work_id &&
            result.workspaceId === project.rootWorkspaceId
          );
        } catch {
          return false;
        }
      });
      expect(committed).toHaveLength(1);
      expect(committed[0]?.command_id).not.toBe(oldRejectedCommandId);
      expect(assignedEvents[0]?.caused_by_command_id).toBe(
        committed[0]?.command_id,
      );
      const rejected = fencedReceipts(completed);
      expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);

      const action = completed.actions.find(
        (candidate) =>
          candidate.execution_id === oldAction.executionId &&
          candidate.logical_action_id === logicalActionId,
      );
      expect(action).toMatchObject({
        provider_turn_id: providerTurnId,
        call_ref: callRef,
        action_kind: "assign_work",
        state: "Applied",
      });
      expect(
        completed.actionObservations.filter(
          (observation) =>
            observation.source_ref === action?.observation_source_ref,
        ),
      ).toHaveLength(1);
      expect(
        completed.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === providerTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ outcome: "Success", attempt_no: 0 }),
      ]);
      expect(actionProviderCalls).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);
    },
    120_000,
  );

  it("converges an old Committed AssignWork receipt after the action stays Pending", async () => {
    const marker = `AH10-assign-work-committed-${crypto.randomUUID().slice(0, 8)}`;
    const sourceObjective = `Exercise committed AssignWork recovery ${marker}.`;
    const targetObjective = `Committed AssignWork result ${marker}.`;
    const events: Ah10Probe[] = [];
    const actionProviderCalls: number[] = [];
    const fixture = await startProductionFixture({
      reply: (call, index) => {
        const context = JSON.stringify(call.messages);
        if (!context.includes(marker)) {
          return { _tag: "HttpError", status: 422 };
        }
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (!available.has("assign_work")) {
          return { _tag: "HttpError", status: 422 };
        }
        if (context.includes("WorkAssigned(")) {
          return { _tag: "Text", text: `Assigned ${marker}.` };
        }
        actionProviderCalls.push(index);
        return {
          _tag: "ToolCall",
          name: "assign_work",
          arguments: {
            objective: targetObjective,
            why: "qualify recovery from a committed AssignWork Command",
            constraints: ["preserve the exact committed Work result"],
            completionExpectation: "one WorkAssigned fact is committed",
            verificationMission: {
              goal: `Verify committed AssignWork ${marker}`,
              criteria: [
                {
                  criterionId: "ah10-committed-assigned-work",
                  requirement: `one Work is assigned for ${marker}`,
                  required: true,
                },
              ],
              riskRequirements: [],
            },
            reason: "AH10 committed-receipt process qualification",
          },
        };
      },
      firstDaemonEntry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 AssignWork committed-receipt recovery",
    );
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: {
        _tag: "WorkspaceAgent",
        workspaceId: project.rootWorkspaceId,
      },
      capability: "core.control.assign-work",
      target: project.rootWorkspaceId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    const sourceWorkId = functionalId("wrk");
    await client.command(project.projectId, "AssignWork", {
      workId: sourceWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: sourceObjective,
      why: "host the WorkspaceWork episode that exercises AssignWork recovery",
      constraints: [],
      completionExpectation: "the model assigns one additional Work",
      verificationMission: {
        goal: `Verify source Work for ${marker}`,
        criteria: [
          {
            criterionId: "ah10-source-work-open",
            requirement: "the source Work remains open during recovery",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "AH10 process fixture" },
      revision: 0,
    });

    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "assign_work" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (oldAction === undefined) {
      throw new Error("AH10 old committed AssignWork ActionIntent was absent");
    }
    const providerTurnId = oldAction.providerTurnId;
    const logicalActionId = oldAction.logicalActionId;
    const callRef = oldAction.callRef;
    if (
      providerTurnId === undefined ||
      logicalActionId === undefined ||
      callRef === undefined
    ) {
      throw new Error("AH10 committed AssignWork omitted pinned identity");
    }
    expect(actionProviderCalls).toHaveLength(1);

    const oldLease = readRows(fixture.databaseFile).leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(oldLease?.generation).toBe(0);
    expect(Date.parse(oldLease?.expires_at ?? "1970-01-01")).toBeGreaterThan(
      Date.now(),
    );

    releaseGate(fixture, "old", "action-intent");
    const handlerReturned = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.callRef === callRef &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      15_000,
    );
    if (handlerReturned === undefined) {
      throw new Error("AH10 post-AssignWork handler probe was absent");
    }

    const beforeCrash = readRows(fixture.databaseFile);
    const targetWorkBefore = targetWorks(beforeCrash, targetObjective);
    expect(targetWorkBefore).toHaveLength(1);
    expect(targetWorkBefore[0]).toMatchObject({
      project_id: project.projectId,
      workspace_id: project.rootWorkspaceId,
      lifecycle: "Open",
      revision: 0,
    });
    const targetEventsBefore = beforeCrash.workAssignedEvents.filter(
      (event) => {
        try {
          return (
            (JSON.parse(event.payload_json) as { objective?: string })
              .objective === targetObjective
          );
        } catch {
          return false;
        }
      },
    );
    expect(targetEventsBefore).toHaveLength(1);
    const targetWorkId = targetWorkBefore[0]?.work_id;
    const committedBefore = beforeCrash.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      try {
        const result = JSON.parse(command.result_json) as {
          workId?: string;
          workspaceId?: string;
        };
        return (
          result.workId === targetWorkId &&
          result.workspaceId === project.rootWorkspaceId
        );
      } catch {
        return false;
      }
    });
    expect(committedBefore).toHaveLength(1);
    expect(fencedReceipts(beforeCrash)).toHaveLength(0);
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: providerTurnId,
        logical_action_id: logicalActionId,
        call_ref: callRef,
        action_kind: "assign_work",
        state: "Pending",
        observation_source_ref: null,
      }),
    );
    expect(
      beforeCrash.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(
      beforeCrash.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success", attempt_no: 0 })]);
    expect(actionProviderCalls).toHaveLength(1);

    await fixture.crash();
    await waitForPublic(
      async () =>
        readRows(fixture.databaseFile).leases.find(
          (lease) => lease.execution_id === oldAction.executionId,
        ),
      (lease) =>
        lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
      35_000,
    );

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const newLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    if (newLease === undefined) {
      throw new Error("AH10 gen1 did not acquire committed AssignWork lease");
    }
    expect(newLease.fencingGeneration).toBe(1);
    const newAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "assign_work" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (newAction === undefined) {
      throw new Error("AH10 gen1 committed AssignWork ActionIntent was absent");
    }
    expect(newAction.providerTurnId).toBe(providerTurnId);
    expect(newAction.callRef).toBe(callRef);
    expect(newAction.logicalActionId).toBe(logicalActionId);

    releaseGate(fixture, "new", "action-intent");
    const recovered = await waitForPublic(
      async () => readRows(fixture.databaseFile),
      (rows) =>
        rows.actions.some(
          (action) =>
            action.execution_id === oldAction.executionId &&
            action.logical_action_id === logicalActionId &&
            action.state === "Applied",
        ),
      30_000,
    );

    expect(targetWorks(recovered, targetObjective)).toEqual(targetWorkBefore);
    const targetEventsAfter = recovered.workAssignedEvents.filter((event) => {
      try {
        return (
          (JSON.parse(event.payload_json) as { objective?: string })
            .objective === targetObjective
        );
      } catch {
        return false;
      }
    });
    expect(targetEventsAfter).toEqual(targetEventsBefore);
    const committedAfter = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      try {
        const result = JSON.parse(command.result_json) as {
          workId?: string;
          workspaceId?: string;
        };
        return (
          result.workId === targetWorkId &&
          result.workspaceId === project.rootWorkspaceId
        );
      } catch {
        return false;
      }
    });
    expect(committedAfter).toEqual(committedBefore);
    expect(fencedReceipts(recovered)).toHaveLength(0);
    const recoveredAction = recovered.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === logicalActionId,
    );
    expect(recoveredAction).toMatchObject({
      provider_turn_id: providerTurnId,
      call_ref: callRef,
      action_kind: "assign_work",
      state: "Applied",
    });
    expect(
      recovered.actionObservations.filter(
        (observation) =>
          observation.source_ref === recoveredAction?.observation_source_ref,
      ),
    ).toHaveLength(1);
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success", attempt_no: 0 })]);
    expect(actionProviderCalls).toHaveLength(1);
    expect(newDaemon.daemonErrors).toEqual([]);
  }, 150_000);
});
