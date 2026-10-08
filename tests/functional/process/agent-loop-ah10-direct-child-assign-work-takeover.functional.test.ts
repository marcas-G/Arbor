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

interface Probe {
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
  readonly why: string;
  readonly constraints: string;
  readonly completion_expectation: string;
  readonly verification_mission: string;
  readonly provenance: string;
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

interface ControlResult {
  readonly _tag?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly status?: string;
  readonly outputText?: string;
}

const fixtures: ProductionFixture[] = [];
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const pushProbe = (events: Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Retain daemon output in the fixture for failure diagnostics.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: "old" | "new",
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
          `SELECT work_id, project_id, workspace_id, objective, why,
                  constraints, completion_expectation, verification_mission,
                  provenance, lifecycle, revision
             FROM works ORDER BY created_at, work_id`,
        )
        .all() as unknown as WorkRow[],
      workAssignedEvents: db
        .prepare(
          `SELECT event_id, event_type, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events WHERE event_type = 'WorkAssigned'
            ORDER BY sequence`,
        )
        .all() as unknown as WorkAssignedEventRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_step_no,
                  a.repair_attempt, a.logical_action_id, a.action_index,
                  a.observation_source_ref, a.call_ref, a.action_kind, a.state
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
        logical_step_no: number;
        repair_attempt: number;
        logical_action_id: string;
        action_index: number;
        observation_source_ref: string | null;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
      controlResults: db
        .prepare(
          `SELECT source_ref, payload_json
             FROM session_entries WHERE item_type = 'ControlResult'
            ORDER BY sequence`,
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
      permissionGrants: db
        .prepare(
          `SELECT permission_grant_id, subject_kind, subject_ref, capability,
                  target, state, expires_at
             FROM permission_grants ORDER BY permission_grant_id`,
        )
        .all() as Array<{
        permission_grant_id: string;
        subject_kind: string;
        subject_ref: string;
        capability: string;
        target: string | null;
        state: string;
        expires_at: string | null;
      }>,
      approvals: db
        .prepare(
          "SELECT approval_id, target_ref, state FROM action_approvals ORDER BY approval_id",
        )
        .all() as Array<{
        approval_id: string;
        target_ref: string;
        state: string;
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

const parseWorkspacesResult = (row: { payload_json: string }) => {
  const result = JSON.parse(row.payload_json) as ControlResult;
  if (
    result._tag !== "ControlResult" ||
    result.actionKind !== "list_workspaces" ||
    result.status !== "Succeeded" ||
    typeof result.outputText !== "string"
  ) {
    throw new Error(
      `list_workspaces did not persist a successful ControlResult: ${row.payload_json}`,
    );
  }
  return JSON.parse(result.outputText) as {
    directChildren?: Array<{ ref: string; name: string }>;
  };
};

describe("AH10 direct-child AssignWork generation takeover", () => {
  it.each(["before", "after"] as const)(
    "assigns to a model-listed direct child after killing gen0 %s its FencingRejected receipt commits",
    async (crashSide) => {
      const marker = `AH10-direct-child-${crypto.randomUUID().slice(0, 8)}`;
      const childName = `child-${marker}`;
      const sourceObjective = `Assign a bounded outcome to ${childName}.`;
      const targetObjective = `Direct-child Work for ${marker}.`;
      const targetWhy = `The existing child owns the responsibility for ${marker}.`;
      const targetReason = `The Parent Work delegates this bounded outcome to ${childName}.`;
      const constraints = [
        "Do not modify files owned by the Parent Workspace.",
        "Preserve the stated scope and do not add external side effects.",
      ];
      const mission = {
        goal: `Verify the bounded child outcome for ${marker}.`,
        criteria: [
          {
            criterionId: "direct-child-result",
            requirement: `the child Work records the requested result for ${marker}`,
            required: true,
          },
        ],
        riskRequirements: ["do not weaken either Work constraint"],
      };
      const events: Probe[] = [];
      const listWorkspaceCalls: number[] = [];
      const assignWorkCalls: number[] = [];
      const providerTrace: Array<{ index: number; tail: string }> = [];
      let listRequested = false;
      let targetWorkspaceRef: string | undefined;

      const fixture = await startProductionFixture({
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          providerTrace.push({ index, tail: context.slice(-1_000) });
          if (!context.includes(marker)) {
            return { _tag: "HttpError", status: 422 };
          }
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (context.includes("WorkAssigned(")) {
            return {
              _tag: "Text",
              text: `The child Work is assigned for ${marker}.`,
            };
          }
          if (!listRequested) {
            if (!available.has("list_workspaces")) {
              return { _tag: "HttpError", status: 422 };
            }
            listRequested = true;
            listWorkspaceCalls.push(index);
            return {
              _tag: "ToolCall",
              name: "list_workspaces",
              arguments: { query: marker },
            };
          }
          const ref = /wref_[a-f0-9]{64}/u.exec(context)?.[0];
          if (ref === undefined || !available.has("assign_work")) {
            return { _tag: "HttpError", status: 422 };
          }
          targetWorkspaceRef = ref;
          assignWorkCalls.push(index);
          return {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              targetWorkspaceRef: ref,
              objective: targetObjective,
              why: targetWhy,
              constraints,
              completionExpectation: `the direct child owns a verified outcome for ${marker}`,
              verificationMission: mission,
              reason: targetReason,
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
        `AH10 direct-child AssignWork ${marker}`,
      );
      const childWorkspaceId = functionalId("ws");
      const childDirectory = resolve(fixture.directory, childName);
      mkdirSync(childDirectory, { recursive: true });
      await client.command(project.projectId, "CreateChildWorkspace", {
        parentWorkspaceId: project.rootWorkspaceId,
        workspaceId: childWorkspaceId,
        primarySession: {
          sessionId: functionalId("ses"),
          contextEpoch: 0,
        },
        name: childName,
        responsibilityDefinition: {
          purpose: `own the bounded responsibility for ${marker}`,
          ownedResponsibilities: [marker],
          obligations: ["accept precisely scoped Work from the Parent"],
          includes: ["the named child outcome"],
          excludes: ["Parent Workspace files and external side effects"],
          interfaces: ["Parent assigns Work through a scoped direct-child ref"],
        },
        responsibilityRevision: 0,
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [{ _tag: "FileTree", path: childDirectory }],
        },
        resourceBoundaryRevision: 0,
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId: childWorkspaceId,
        },
        workspacePolicy: {},
        workspacePolicyRevision: 0,
        revision: 0,
      });
      const childDetail = await client.view<{
        boundary?: {
          addresses?: ReadonlyArray<{ _tag: string; path?: string }>;
        };
      }>("workspace-detail", { workspaceId: childWorkspaceId });
      expect(childDetail.boundary?.addresses).toContainEqual({
        _tag: "FileTree",
        path: childDirectory,
      });

      const parentWorkId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId: parentWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: sourceObjective,
        why: "host the Parent WorkEpisode for direct-child assignment qualification",
        constraints: ["the resulting Work must target the listed direct child"],
        completionExpectation:
          "one exact child Work is assigned under the Parent",
        verificationMission: {
          goal: `Verify assignment to the existing child ${marker}`,
          criteria: [
            {
              criterionId: "parent-assigned-child",
              requirement:
                "the Work is assigned to the exact listed child Workspace",
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
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `Direct-child AssignWork ActionIntent absent: ${error instanceof Error ? error.message : String(error)}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; assignWorkCalls=${JSON.stringify(assignWorkCalls)}; targetRef=${targetWorkspaceRef}; provider=${JSON.stringify(providerTrace)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (oldAction === undefined || targetWorkspaceRef === undefined) {
        throw new Error("the model did not reach direct-child AssignWork");
      }
      const providerTurnId = oldAction.providerTurnId;
      const logicalActionId = oldAction.logicalActionId;
      const callRef = oldAction.callRef;
      if (
        providerTurnId === undefined ||
        logicalActionId === undefined ||
        callRef === undefined
      ) {
        throw new Error("Direct-child AssignWork omitted pinned identity");
      }
      expect(listWorkspaceCalls).toHaveLength(1);
      expect(assignWorkCalls).toHaveLength(1);
      expect(targetWorkspaceRef).toMatch(/^wref_[a-f0-9]{64}$/u);
      expect(targetWorkspaceRef).not.toContain(childWorkspaceId);

      const listControlRows = readRows(
        fixture.databaseFile,
      ).controlResults.filter(
        (row) =>
          (JSON.parse(row.payload_json) as ControlResult).actionKind ===
          "list_workspaces",
      );
      expect(listControlRows).toHaveLength(1);
      const listControlRow = listControlRows[0];
      if (listControlRow === undefined) {
        throw new Error("list_workspaces ControlResult row is absent");
      }
      const listControlResult = JSON.parse(
        listControlRow.payload_json,
      ) as ControlResult;
      if (listControlResult?.callRef === undefined) {
        throw new Error("list_workspaces ControlResult omitted its callRef");
      }
      expect(listControlResult.callRef).toMatch(/^call_/u);
      const persistedListResult = parseWorkspacesResult(
        listControlRow,
      ).directChildren?.find((child) => child.name === childName);
      expect(persistedListResult).toEqual({
        ref: targetWorkspaceRef,
        name: childName,
        responsibilitySummary: `own the bounded responsibility for ${marker}`,
        currentWorkSummary: null,
        openWorkCount: 0,
        readyResults: [],
        revision: 0,
      });

      // The old daemon is held at the exact Agent ActionIntent boundary. The
      // target is the wref recovered from its persisted successful
      // list_workspaces ControlResult, not a fabricated or derived ref.
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "core.control.assign-work",
        target: targetWorkspaceRef,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      const grantRows = readRows(fixture.databaseFile).permissionGrants.filter(
        (grant) =>
          grant.subject_kind === "WorkspaceAgent" &&
          grant.subject_ref === project.rootWorkspaceId &&
          grant.capability === "core.control.assign-work" &&
          grant.target === targetWorkspaceRef &&
          grant.state === "Active",
      );
      expect(grantRows).toHaveLength(1);
      expect(
        targetWorks(readRows(fixture.databaseFile), targetObjective),
      ).toHaveLength(0);

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
        throw new Error("Direct-child AssignWork old lease probe was absent");
      }
      expect(oldLeasePause.fencingGeneration).toBe(0);
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
          `Direct-child AssignWork gen1 lease absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(fixture.databaseFile))}; daemon=${newDaemon.daemonErrors.join(" | ")}`,
        );
      });
      if (newLease === undefined) {
        throw new Error("Direct-child AssignWork gen1 did not acquire lease");
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
        throw new Error("Direct-child AssignWork gen1 ActionIntent absent");
      }
      expect(newAction.providerTurnId).toBe(providerTurnId);
      expect(newAction.logicalActionId).toBe(logicalActionId);
      expect(newAction.callRef).toBe(callRef);
      expect(assignWorkCalls).toHaveLength(1);

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
        if (beforeCommit?.commandId === undefined) {
          throw new Error(
            "Direct-child FencingRejected precommit probe absent",
          );
        }
        oldRejectedCommandId = beforeCommit.commandId;
        expect(oldRejectedCommandId).toMatch(/^cmd_/u);
        expect(fencedReceipts(readRows(fixture.databaseFile))).toHaveLength(0);
        expect(
          targetWorks(readRows(fixture.databaseFile), targetObjective),
        ).toHaveLength(0);
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
      }

      await fixture.crash();
      if (crashSide === "before") {
        const afterKill = readRows(fixture.databaseFile);
        expect(fencedReceipts(afterKill)).toHaveLength(0);
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
          ) &&
          rows.controlResults.some((row) => {
            const result = JSON.parse(row.payload_json) as ControlResult;
            return (
              result.actionKind === "assign_work" && result.callRef === callRef
            );
          }),
        30_000,
      );

      const assignedWorks = targetWorks(completed, targetObjective);
      expect(assignedWorks).toHaveLength(1);
      const assigned = assignedWorks[0];
      if (assigned === undefined) {
        throw new Error("Direct-child AssignWork did not persist its Work row");
      }
      expect(assigned).toMatchObject({
        project_id: project.projectId,
        workspace_id: childWorkspaceId,
        objective: targetObjective,
        why: targetWhy,
        constraints: JSON.stringify(constraints),
        completion_expectation: `the direct child owns a verified outcome for ${marker}`,
        verification_mission: JSON.stringify(mission),
        lifecycle: "Open",
        revision: 0,
      });
      expect(JSON.parse(assigned.provenance)).toEqual({
        predecessorWorkId: parentWorkId,
        reason: targetReason,
      });

      const assignedEvents = completed.workAssignedEvents.filter((event) => {
        try {
          const payload = JSON.parse(event.payload_json) as {
            workId?: string;
            workspaceId?: string;
          };
          return payload.workId === assigned.work_id;
        } catch {
          return false;
        }
      });
      expect(assignedEvents).toHaveLength(1);
      expect(assignedEvents[0]?.aggregate_ref).toBe(childWorkspaceId);

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
            result.workId === assigned.work_id &&
            result.workspaceId === childWorkspaceId
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
      expect(fencedReceipts(completed)).toHaveLength(
        crashSide === "before" ? 0 : 1,
      );

      const actionRows = completed.actions.filter(
        (action) => action.execution_id === oldAction.executionId,
      );
      expect(actionRows).toHaveLength(2);
      expect(
        actionRows.filter(
          (action) =>
            action.action_kind === "assign_work" && action.call_ref === callRef,
        ),
      ).toEqual([
        expect.objectContaining({
          provider_turn_id: providerTurnId,
          logical_action_id: logicalActionId,
          action_index: 0,
          call_ref: callRef,
          action_kind: "assign_work",
          state: "Applied",
          observation_source_ref: expect.any(String),
        }),
      ]);
      expect(
        actionRows.filter((action) => action.action_kind === "list_workspaces"),
      ).toHaveLength(1);
      const listAction = actionRows.find(
        (action) => action.action_kind === "list_workspaces",
      );
      const assignmentAction = actionRows.find(
        (action) => action.action_kind === "assign_work",
      );
      expect(listAction).toMatchObject({
        provider_turn_id: expect.stringMatching(/^ptn_/u),
        logical_step_no: 0,
        repair_attempt: 0,
        action_index: 0,
        call_ref: listControlResult.callRef,
        state: "Applied",
        observation_source_ref: expect.any(String),
      });
      expect(listAction?.observation_source_ref).toBe(
        listControlRow.source_ref,
      );
      const finalListControlResults = completed.controlResults.filter((row) => {
        const result = JSON.parse(row.payload_json) as ControlResult;
        return (
          result.actionKind === "list_workspaces" &&
          result.callRef === listControlResult.callRef
        );
      });
      expect(finalListControlResults).toHaveLength(1);
      expect(finalListControlResults[0]?.source_ref).toBe(
        listAction?.observation_source_ref,
      );
      expect(assignmentAction?.provider_turn_id).toBe(providerTurnId);
      expect(assignmentAction?.logical_step_no).toBe(1);
      expect(assignmentAction?.repair_attempt).toBe(0);
      expect(listAction?.logical_action_id).not.toBe(logicalActionId);
      expect(listAction?.call_ref).not.toBe(callRef);
      const observation = completed.controlResults
        .map((row) => JSON.parse(row.payload_json) as ControlResult)
        .filter(
          (result) =>
            result.actionKind === "assign_work" && result.callRef === callRef,
        );
      expect(observation).toHaveLength(1);
      expect(observation[0]?.status).toBe("Succeeded");
      expect(
        completed.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === providerTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ outcome: "Success", attempt_no: 0 }),
      ]);
      expect(listWorkspaceCalls).toHaveLength(1);
      expect(assignWorkCalls).toHaveLength(1);
      expect(
        completed.approvals.filter(
          (approval) => approval.target_ref === targetWorkspaceRef,
        ),
      ).toHaveLength(0);
      expect(fixture.daemonErrors).toEqual([]);
      expect(newDaemon.daemonErrors).toEqual([]);
      releaseGate(fixture, "new", "action-result");
      await newDaemon.crash();
    },
    180_000,
  );
});
