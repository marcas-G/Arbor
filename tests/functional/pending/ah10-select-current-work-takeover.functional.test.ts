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

interface DecisionRow {
  readonly decision_id: string;
  readonly workspace_id: string;
  readonly candidate_work_ids_json: string;
  readonly workspace_revision: number;
  readonly state: "Pending" | "Submitted";
  readonly selected_work_id: string | null;
  readonly revision: number;
}

interface CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
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
      decisions: db
        .prepare(
          `SELECT decision_id, workspace_id, candidate_work_ids_json,
                  workspace_revision, state, selected_work_id, revision
             FROM work_selection_decision_requests ORDER BY created_at`,
        )
        .all() as unknown as DecisionRow[],
      executions: db
        .prepare(
          `SELECT execution_id, binding_kind, episode_kind, episode_ref,
                  episode_revision
             FROM executions`,
        )
        .all() as Array<{
        execution_id: string;
        binding_kind: string;
        episode_kind: string | null;
        episode_ref: string | null;
        episode_revision: number | null;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands ORDER BY created_at",
        )
        .all() as unknown as CommandRow[],
      works: db
        .prepare(
          "SELECT work_id, project_id, workspace_id, objective, lifecycle, revision FROM works ORDER BY created_at",
        )
        .all() as Array<{
        work_id: string;
        project_id: string;
        workspace_id: string;
        objective: string;
        lifecycle: string;
        revision: number;
      }>,
      workspaces: db
        .prepare(
          "SELECT workspace_id, current_work_id, revision FROM workspaces",
        )
        .all() as Array<{
        workspace_id: string;
        current_work_id: string | null;
        revision: number;
      }>,
      waits: db
        .prepare("SELECT work_id, wait_mode, conditions_json FROM work_waits")
        .all() as Array<{
        work_id: string;
        wait_mode: string;
        conditions_json: string;
      }>,
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
      observations: db
        .prepare(
          `SELECT source_ref, payload_json
             FROM session_entries
            WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'
            ORDER BY sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
      events: db
        .prepare(
          "SELECT event_type, aggregate_ref, payload_json FROM domain_events WHERE event_type = 'CurrentWorkChanged'",
        )
        .all() as Array<{
        event_type: string;
        aggregate_ref: string;
        payload_json: string;
      }>,
    };
  } finally {
    db.close();
  }
};

const availableTools = (call: {
  readonly tools: ReadonlyArray<{ function?: { name?: string } }>;
}) =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const extractCandidateWorkIds = (messages: ReadonlyArray<unknown>) => {
  const serialized = JSON.stringify(messages);
  const candidateList = /candidateWorkIds[^[]*\[([^\]]+)\]/u.exec(serialized);
  if (candidateList?.[1] === undefined) return [];
  return [...candidateList[1].matchAll(/wrk_[0-9a-f-]{36}/gu)].map(
    (match) => match[0] as string,
  );
};

const workAssignment = (label: string, marker: string) => ({
  objective: `${label} candidate for ${marker}`,
  why: "create multiple runnable Works for Scheduler selection qualification",
  constraints: [],
  completionExpectation: `select this candidate for ${marker}`,
  verificationMission: {
    goal: `Verify selection candidate ${label} for ${marker}`,
    criteria: [
      {
        criterionId: `candidate-${label.toLowerCase()}`,
        requirement: `the Scheduler candidate ${label} can be selected`,
        required: true,
      },
    ],
    riskRequirements: [],
  },
  reason: "exercise exact DecisionEpisode selection across owner generations",
});

describe("AH10 real daemon SelectCurrentWork generation takeover", () => {
  it.each(["before", "after"] as const)(
    "takes over the genuine Scheduler DecisionEpisode after gen0 FencingRejected receipt commits %s",
    async (crashSide) => {
      const marker = `AH10-select-work-${crypto.randomUUID().slice(0, 8)}`;
      const events: Ah10Probe[] = [];
      let assignmentsSent = false;
      let waitSent = false;
      let selectionProviderCalls = 0;
      let selectedWorkId: string | undefined;
      const fixture = await startProductionFixture({
        reply: (call) => {
          const tools = availableTools(call);
          const messageText = JSON.stringify(call.messages);

          if (tools.has("select_current_work")) {
            selectionProviderCalls += 1;
            const candidates = extractCandidateWorkIds(call.messages);
            if (candidates.length < 2) {
              return { _tag: "HttpError", status: 422 };
            }
            selectedWorkId = candidates[0];
            return {
              _tag: "ToolCall",
              name: "select_current_work",
              arguments: { workId: selectedWorkId },
            };
          }

          if (
            messageText.includes(marker) &&
            tools.has("assign_work") &&
            !assignmentsSent
          ) {
            assignmentsSent = true;
            return {
              _tag: "ToolCalls",
              calls: [
                { name: "assign_work", arguments: workAssignment("B", marker) },
                { name: "assign_work", arguments: workAssignment("C", marker) },
              ],
            };
          }

          if (
            messageText.includes(marker) &&
            tools.has("wait") &&
            assignmentsSent &&
            !waitSent
          ) {
            waitSent = true;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `wait while Scheduler chooses one runnable candidate for ${marker}`,
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            };
          }

          return { _tag: "Text", text: `Observed ${marker}.` };
        },
        firstDaemonEntry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_GATE_ACTION_KIND: "select_current_work",
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
        "AH10 SelectCurrentWork generation takeover",
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
        expiresAt: null,
      });

      const currentWorkId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId: currentWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: `Stage Scheduler selection candidates for ${marker}.`,
        why: "create one waiting current Work and two runnable alternatives",
        constraints: [],
        completionExpectation:
          "Scheduler admits a DecisionEpisode for two runnable Works",
        verificationMission: {
          goal: `Verify Scheduler selection setup for ${marker}`,
          criteria: [
            {
              criterionId: "decision-episode-created",
              requirement:
                "two runnable alternatives produce a persisted selection decision",
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
              event.actionKind === "select_current_work" &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        90_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH10 SelectCurrentWork intent absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; provider=${JSON.stringify(fixture.providerCalls.map((call) => ({ tools: [...availableTools(call)], messages: call.messages })))}; rows=${JSON.stringify(readRows(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      expect(oldAction?.providerTurnId).toMatch(/^ptn_/u);
      expect(oldAction?.logicalActionId).toMatch(/^lac_/u);
      expect(oldAction?.callRef).toMatch(/^call_/u);
      expect(assignmentsSent).toBe(true);
      expect(waitSent).toBe(true);
      expect(selectionProviderCalls).toBe(1);
      if (oldAction === undefined || selectedWorkId === undefined) {
        throw new Error(
          "Scheduler did not produce the target selection action",
        );
      }

      const staged = await waitForPublic(
        async () => readRows(fixture.databaseFile),
        (rows) =>
          rows.decisions.length === 1 &&
          rows.decisions[0]?.state === "Pending" &&
          JSON.parse(rows.decisions[0].candidate_work_ids_json).length === 2 &&
          rows.executions.some(
            (execution) =>
              execution.execution_id === oldAction.executionId &&
              execution.episode_kind === "DecisionEpisode",
          ),
        10_000,
      );
      const request = staged.decisions[0];
      if (request === undefined)
        throw new Error("DecisionRequest row is absent");
      const candidateWorkIds = JSON.parse(
        request.candidate_work_ids_json,
      ) as string[];
      expect(candidateWorkIds).toHaveLength(2);
      expect(candidateWorkIds).toContain(selectedWorkId);
      expect(candidateWorkIds).not.toContain(currentWorkId);
      expect(request).toMatchObject({
        workspace_id: project.rootWorkspaceId,
        state: "Pending",
        selected_work_id: null,
        revision: 0,
      });
      const decisionEpisode = staged.executions.filter(
        (episode) =>
          episode.execution_id === oldAction.executionId &&
          episode.episode_kind === "DecisionEpisode",
      );
      expect(decisionEpisode).toHaveLength(1);
      expect(decisionEpisode[0]).toMatchObject({
        binding_kind: "workspace",
        episode_ref: request.decision_id,
        episode_revision: 0,
      });
      const oldWorkspace = staged.workspaces.find(
        (workspace) => workspace.workspace_id === project.rootWorkspaceId,
      );
      expect(oldWorkspace?.current_work_id).toBe(currentWorkId);
      expect(staged.waits).toContainEqual(
        expect.objectContaining({ work_id: currentWorkId }),
      );

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
      expect(oldLeasePause?.fencingGeneration).toBe(0);
      const oldLease = staged.leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      expect(oldLease?.generation).toBe(0);
      if (oldLease === undefined) throw new Error("gen0 lease row is absent");
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
          ARBOR_AH10_GATE_ACTION_KIND: "select_current_work",
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
          `AH10 gen1 did not acquire DecisionEpisode lease: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(fixture.databaseFile))}; newDaemon=${newDaemon.daemonErrors.join(" | ")}`,
        );
      });
      expect(newLease?.fencingGeneration).toBe(1);
      const newAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "select_current_work" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
      expect(newAction?.callRef).toBe(oldAction.callRef);
      expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);
      expect(selectionProviderCalls).toBe(1);

      releaseGate(fixture, "old", "action-intent");
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
        expect(beforeCommit?.commandId).toMatch(/^cmd_/u);
        expect(
          readRows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      } else {
        await waitForPublic(
          async () =>
            readRows(fixture.databaseFile).commands.filter(
              (command) =>
                command.resolution === "TerminalRejected" &&
                command.terminal_error_json?.includes("FencingRejected"),
            ),
          (rows) => rows.length === 1,
          15_000,
        );
      }

      const fencedBeforeKill = readRows(fixture.databaseFile).commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      );
      expect(
        readRows(fixture.databaseFile).workspaces.find(
          (workspace) => workspace.workspace_id === project.rootWorkspaceId,
        )?.current_work_id,
      ).toBe(currentWorkId);
      await fixture.crash();
      if (crashSide === "before") {
        expect(
          readRows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      }

      releaseGate(fixture, "new", "action-intent");
      const applied = await waitForPublic(
        async () => readRows(fixture.databaseFile),
        (rows) =>
          rows.actions.some(
            (action) =>
              action.execution_id === oldAction.executionId &&
              action.logical_action_id === oldAction.logicalActionId &&
              action.action_kind === "select_current_work" &&
              action.state === "Applied",
          ) &&
          rows.decisions.some(
            (decision) =>
              decision.decision_id === request.decision_id &&
              decision.state === "Submitted" &&
              decision.selected_work_id === selectedWorkId,
          ),
        30_000,
      );

      const finalRequest = applied.decisions.filter(
        (decision) => decision.decision_id === request.decision_id,
      );
      expect(finalRequest).toEqual([
        expect.objectContaining({
          state: "Submitted",
          selected_work_id: selectedWorkId,
          revision: 1,
        }),
      ]);
      const committed = applied.commands.filter((command) => {
        if (command.resolution !== "Committed" || command.result_json === null)
          return false;
        try {
          const result = JSON.parse(command.result_json) as {
            workspaceId?: string;
            workId?: string;
            revision?: number;
          };
          return (
            result.workspaceId === project.rootWorkspaceId &&
            result.workId === selectedWorkId &&
            result.revision === (oldWorkspace?.revision ?? 0) + 1
          );
        } catch {
          return false;
        }
      });
      expect(committed).toHaveLength(1);
      const oldCommandId =
        crashSide === "before"
          ? events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeFencedReceiptCommit" &&
                event.executionId === oldAction.executionId,
            )?.commandId
          : fencedBeforeKill[0]?.command_id;
      expect(oldCommandId).toMatch(/^cmd_/u);
      expect(committed[0]?.command_id).not.toBe(oldCommandId);
      expect(fencedBeforeKill).toHaveLength(crashSide === "before" ? 0 : 1);
      expect(applied.workspaces).toContainEqual(
        expect.objectContaining({
          workspace_id: project.rootWorkspaceId,
          current_work_id: selectedWorkId,
          revision: (oldWorkspace?.revision ?? 0) + 1,
        }),
      );
      expect(
        applied.events.filter(
          (event) =>
            event.aggregate_ref === project.rootWorkspaceId &&
            (JSON.parse(event.payload_json) as { workId?: string }).workId ===
              selectedWorkId,
        ),
      ).toHaveLength(1);
      const targetActions = applied.actions.filter(
        (action) => action.logical_action_id === oldAction.logicalActionId,
      );
      expect(targetActions).toHaveLength(1);
      expect(targetActions[0]).toMatchObject({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        action_index: 0,
        call_ref: oldAction.callRef,
        action_kind: "select_current_work",
        state: "Applied",
      });
      const observationSourceRef = targetActions[0]?.observation_source_ref;
      expect(observationSourceRef).toMatch(/^observation_/u);
      expect(
        applied.observations.filter(
          (observation) => observation.source_ref === observationSourceRef,
        ),
      ).toHaveLength(1);
      expect(selectionProviderCalls).toBe(1);
      expect(
        fixture.providerCalls.filter((call) =>
          availableTools(call).has("select_current_work"),
        ),
      ).toHaveLength(1);

      const publicCurrentWork = await client.view<{
        workId?: string;
        objective?: string;
      } | null>("current-work", { workspaceId: project.rootWorkspaceId });
      expect(publicCurrentWork?.workId).toBe(selectedWorkId);
      expect(
        applied.actions.filter(
          (action) => action.action_kind === "select_current_work",
        ),
      ).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);

      releaseGate(fixture, "new", "action-result");
      await newDaemon.crash();
    },
    180_000,
  );
});
