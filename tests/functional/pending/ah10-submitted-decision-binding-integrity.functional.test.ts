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

interface Snapshot {
  readonly leases: Array<{
    execution_id: string;
    generation: number;
    expires_at: string;
  }>;
  readonly decisions: DecisionRow[];
  readonly executions: Array<{
    execution_id: string;
    binding_kind: string;
    episode_kind: string | null;
    episode_ref: string | null;
    episode_revision: number | null;
    settled_at: string | null;
    settlement_kind: string | null;
  }>;
  readonly steps: Array<{
    execution_id: string;
    logical_step_no: number;
    repair_attempt: number;
    provider_turn_id: string;
    manifest_id: string | null;
    state: string;
    revision: number;
    next_action_index: number;
    settlement_json: string | null;
  }>;
  readonly commands: CommandRow[];
  readonly works: Array<{
    work_id: string;
    project_id: string;
    workspace_id: string;
    objective: string;
    lifecycle: string;
    revision: number;
  }>;
  readonly workspaces: Array<{
    workspace_id: string;
    current_work_id: string | null;
    revision: number;
  }>;
  readonly actions: Array<{
    execution_id: string;
    logical_step_no: number;
    repair_attempt: number;
    provider_turn_id: string;
    logical_action_id: string;
    action_index: number;
    observation_source_ref: string | null;
    call_ref: string;
    action_kind: string;
    state: string;
  }>;
  readonly observations: Array<{ source_ref: string; payload_json: string }>;
  readonly events: Array<{
    event_type: string;
    aggregate_ref: string;
    payload_json: string;
  }>;
  readonly attempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    settled_at: string | null;
  }>;
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
    // Daemon logs are retained for failure diagnostics.
  }
};

const releaseGate = (fixture: ProductionFixture, role: string, gate: string) =>
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );

const readRows = (databaseFile: string): Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all() as Snapshot["leases"],
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
                  episode_revision, settled_at, settlement_kind
             FROM executions ORDER BY admitted_at`,
        )
        .all() as Snapshot["executions"],
      steps: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id,
                  manifest_id, state, revision, next_action_index, settlement_json
             FROM agent_loop_steps ORDER BY execution_id, logical_step_no, repair_attempt`,
        )
        .all() as Snapshot["steps"],
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands ORDER BY created_at",
        )
        .all() as unknown as CommandRow[],
      works: db
        .prepare(
          "SELECT work_id, project_id, workspace_id, objective, lifecycle, revision FROM works ORDER BY created_at",
        )
        .all() as Snapshot["works"],
      workspaces: db
        .prepare(
          "SELECT workspace_id, current_work_id, revision FROM workspaces ORDER BY workspace_id",
        )
        .all() as Snapshot["workspaces"],
      actions: db
        .prepare(
          `SELECT a.execution_id, a.logical_step_no, a.repair_attempt,
                  s.provider_turn_id, a.logical_action_id, a.action_index,
                  a.observation_source_ref, a.call_ref, a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            ORDER BY a.execution_id, a.logical_step_no, a.repair_attempt, a.action_index`,
        )
        .all() as Snapshot["actions"],
      observations: db
        .prepare(
          `SELECT source_ref, payload_json
             FROM session_entries
            WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'
            ORDER BY sequence`,
        )
        .all() as Snapshot["observations"],
      events: db
        .prepare(
          "SELECT event_type, aggregate_ref, payload_json FROM domain_events WHERE event_type = 'CurrentWorkChanged' ORDER BY sequence",
        )
        .all() as Snapshot["events"],
      attempts: db
        .prepare(
          `SELECT provider_turn_id, attempt_no, outcome, settled_at
             FROM provider_attempts ORDER BY provider_turn_id, attempt_no`,
        )
        .all() as Snapshot["attempts"],
    };
  } finally {
    db.close();
  }
};

const selectReceipt = (
  rows: Snapshot,
  projectRootWorkspaceId: string,
  selectedWorkId: string,
  revision: number,
) =>
  rows.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null) {
      return false;
    }
    try {
      const result = JSON.parse(command.result_json) as {
        workspaceId?: string;
        workId?: string;
        revision?: number;
      };
      return (
        result.workspaceId === projectRootWorkspaceId &&
        result.workId === selectedWorkId &&
        result.revision === revision
      );
    } catch {
      return false;
    }
  });

const selectionCalls = (fixture: ProductionFixture) =>
  fixture.providerCalls.filter((call) =>
    call.tools.some((tool) => tool.function?.name === "select_current_work"),
  );

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

describe("AH10 fail-closed Submitted DecisionEpisode bindings", () => {
  it.each(["workspace", "manifest"] as const)(
    "does not resume a Committed SelectCurrentWork action with a corrupted %s binding",
    async (corruption) => {
      const marker = `AH10-submitted-binding-${corruption}-${crypto.randomUUID().slice(0, 8)}`;
      const events: Probe[] = [];
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
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT: "0",
          ARBOR_AH10_PAUSE_BEFORE_TERMINAL_ACTION: "1",
        },
        onDaemonStdout: (line) => pushProbe(events, line),
      });
      fixtures.push(fixture);
      mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH10 submitted binding integrity ${corruption}`,
      );
      let foreignWorkspaceId: string | undefined;
      if (corruption === "workspace") {
        foreignWorkspaceId = functionalId("ws");
        const foreignDirectory = resolve(
          fixture.directory,
          `foreign-${marker}`,
        );
        mkdirSync(foreignDirectory, { recursive: true });
        await client.command(project.projectId, "CreateChildWorkspace", {
          parentWorkspaceId: project.rootWorkspaceId,
          workspaceId: foreignWorkspaceId,
          primarySession: {
            sessionId: functionalId("ses"),
            contextEpoch: 0,
          },
          name: `foreign-${marker}`,
          responsibilityDefinition: {
            purpose: `provide a valid foreign Workspace id for ${marker}`,
            ownedResponsibilities: [marker],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          },
          responsibilityRevision: 0,
          resourceBoundary: {
            basisResponsibilityRevision: 0,
            addresses: [{ _tag: "FileTree", path: foreignDirectory }],
          },
          resourceBoundaryRevision: 0,
          agentBinding: {
            _tag: "ResponsibilityBoundAgentBinding",
            workspaceId: foreignWorkspaceId,
          },
          workspacePolicy: {},
          workspacePolicyRevision: 0,
          revision: 0,
        });
      }

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
        provenance: { predecessorWorkId: null, reason: "AH10 binding fixture" },
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
      );
      if (oldAction === undefined || selectedWorkId === undefined) {
        throw new Error(
          "Scheduler did not produce the target selection action",
        );
      }
      expect(assignmentsSent).toBe(true);
      expect(waitSent).toBe(true);
      expect(selectionProviderCalls).toBe(1);

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
      if (request === undefined) throw new Error("DecisionRequest row absent");
      expect(request.candidate_work_ids_json).toContain(selectedWorkId);
      const oldWorkspace = staged.workspaces.find(
        (workspace) => workspace.workspace_id === project.rootWorkspaceId,
      );
      expect(oldWorkspace?.current_work_id).toBe(currentWorkId);

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
      if (oldLease === undefined) throw new Error("gen0 lease row absent");
      releaseGate(fixture, "old", "lease-renewal");
      await waitForPublic(
        async () =>
          readRows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined &&
          Date.parse(lease.expires_at) > Date.parse(oldLease.expires_at) &&
          Date.parse(lease.expires_at) > Date.now(),
        15_000,
      );
      releaseGate(fixture, "old", "action-intent");

      const ah9Pause = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH9BeforeTerminalActionCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionKind === "select_current_work" &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        15_000,
      );
      if (ah9Pause === undefined)
        throw new Error("AH9 pre-terminal gate absent");

      const beforeCorruption = readRows(fixture.databaseFile);
      const baseRequest = beforeCorruption.decisions.find(
        (decision) => decision.decision_id === request.decision_id,
      );
      if (baseRequest === undefined)
        throw new Error("DecisionRequest disappeared");
      const baseStep = beforeCorruption.steps.find(
        (step) =>
          step.execution_id === oldAction.executionId &&
          step.logical_step_no === 0 &&
          step.repair_attempt === 0 &&
          step.provider_turn_id === oldAction.providerTurnId,
      );
      if (baseStep === undefined || baseStep.manifest_id === null) {
        throw new Error("AH9 target Step/Manifest is absent");
      }
      const originalReceipt = selectReceipt(
        beforeCorruption,
        project.rootWorkspaceId,
        selectedWorkId,
        (oldWorkspace?.revision ?? 0) + 1,
      );
      expect(originalReceipt).toHaveLength(1);
      const pinnedProviderAttempts = beforeCorruption.attempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      );
      expect(pinnedProviderAttempts).toHaveLength(1);
      expect(baseRequest).toMatchObject({
        workspace_id: project.rootWorkspaceId,
        state: "Submitted",
        selected_work_id: selectedWorkId,
        revision: 1,
      });
      expect(baseStep).toMatchObject({
        state: "ActionsInProgress",
        next_action_index: 0,
        settlement_json: null,
      });
      expect(
        beforeCorruption.actions.find(
          (action) => action.logical_action_id === oldAction.logicalActionId,
        ),
      ).toMatchObject({ state: "Pending", observation_source_ref: null });
      expect(
        beforeCorruption.observations.filter((observation) =>
          observation.source_ref.startsWith(
            `observation_${oldAction.executionId}_`,
          ),
        ),
      ).toHaveLength(0);

      const db = new DatabaseSync(fixture.databaseFile);
      try {
        if (corruption === "workspace") {
          if (foreignWorkspaceId === undefined) {
            throw new Error("Foreign Workspace fixture was not created");
          }
          db.prepare(
            "UPDATE work_selection_decision_requests SET workspace_id = ? WHERE decision_id = ?",
          ).run(foreignWorkspaceId, request.decision_id);
        } else {
          const alternativeManifest = db
            .prepare(
              `SELECT manifest_id FROM model_context_manifests
                WHERE provider_turn_id <> ? ORDER BY created_at, manifest_id LIMIT 1`,
            )
            .get(baseStep.provider_turn_id) as
            | { manifest_id: string }
            | undefined;
          if (
            alternativeManifest === undefined ||
            alternativeManifest.manifest_id === baseStep.manifest_id
          ) {
            throw new Error("No second durable Manifest is available");
          }
          db.prepare(
            `UPDATE agent_loop_steps SET manifest_id = ?
              WHERE execution_id = ? AND logical_step_no = 0 AND repair_attempt = 0`,
          ).run(alternativeManifest.manifest_id, oldAction.executionId);
        }
      } finally {
        db.close();
      }

      const corrupted = readRows(fixture.databaseFile);
      expect(
        selectReceipt(
          corrupted,
          project.rootWorkspaceId,
          selectedWorkId,
          (oldWorkspace?.revision ?? 0) + 1,
        ),
      ).toEqual(originalReceipt);
      expect(corrupted.workspaces).toEqual(beforeCorruption.workspaces);
      expect(corrupted.works).toEqual(beforeCorruption.works);
      expect(corrupted.executions).toEqual(beforeCorruption.executions);
      expect(corrupted.commands).toEqual(beforeCorruption.commands);
      expect(corrupted.events).toEqual(beforeCorruption.events);
      expect(corrupted.actions).toEqual(beforeCorruption.actions);
      expect(corrupted.observations).toEqual(beforeCorruption.observations);
      expect(
        corrupted.steps.filter(
          (step) => step.execution_id === oldAction.executionId,
        ),
      ).toHaveLength(1);
      if (corruption === "workspace") {
        expect(corrupted.decisions).toEqual([
          expect.objectContaining({
            ...baseRequest,
            workspace_id: foreignWorkspaceId,
          }),
        ]);
        expect(
          corrupted.steps.find(
            (step) => step.execution_id === oldAction.executionId,
          ),
        ).toEqual(baseStep);
      } else {
        expect(corrupted.decisions).toEqual(beforeCorruption.decisions);
        expect(
          corrupted.steps.find(
            (step) => step.execution_id === oldAction.executionId,
          ),
        ).not.toEqual(baseStep);
        expect(
          corrupted.steps.find(
            (step) => step.execution_id === oldAction.executionId,
          )?.manifest_id,
        ).not.toBe(baseStep.manifest_id);
      }

      await fixture.crash();
      const afterOldKill = readRows(fixture.databaseFile);
      expect(afterOldKill.commands).toEqual(corrupted.commands);
      expect(afterOldKill.events).toEqual(corrupted.events);
      expect(afterOldKill.decisions).toEqual(corrupted.decisions);
      expect(afterOldKill.actions).toEqual(corrupted.actions);
      expect(afterOldKill.observations).toEqual(corrupted.observations);
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
      await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined && event.fencingGeneration === 1,
        45_000,
      );
      const result = await waitForPublic(
        async () => ({
          rows: readRows(fixture.databaseFile),
          actionIntent: events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionKind === "select_current_work" &&
              event.actionIndex === 0,
          ),
        }),
        ({ rows, actionIntent }) =>
          actionIntent !== undefined ||
          rows.executions.some(
            (execution) =>
              execution.execution_id === oldAction.executionId &&
              execution.settled_at !== null,
          ),
        20_000,
      );

      const finalRows = result.rows;
      const targetExecution = finalRows.executions.find(
        (execution) => execution.execution_id === oldAction.executionId,
      );
      const targetStep = finalRows.steps.find(
        (step) =>
          step.execution_id === oldAction.executionId &&
          step.logical_step_no === 0 &&
          step.repair_attempt === 0 &&
          step.provider_turn_id === oldAction.providerTurnId,
      );
      const targetAction = finalRows.actions.find(
        (action) => action.logical_action_id === oldAction.logicalActionId,
      );
      const targetExecutionObservations = finalRows.observations.filter(
        (observation) =>
          observation.source_ref.startsWith(
            `observation_${oldAction.executionId}_`,
          ),
      );

      expect(selectionCalls(fixture)).toHaveLength(1);
      expect(
        finalRows.attempts.filter(
          (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
        ),
      ).toHaveLength(1);
      expect(
        selectReceipt(
          finalRows,
          project.rootWorkspaceId,
          selectedWorkId,
          (oldWorkspace?.revision ?? 0) + 1,
        ),
      ).toEqual(originalReceipt);
      expect(finalRows.decisions).toHaveLength(1);
      expect(
        finalRows.executions.filter(
          (execution) =>
            execution.episode_kind === "DecisionEpisode" &&
            execution.episode_ref === request.decision_id,
        ),
      ).toHaveLength(1);
      expect(
        finalRows.attempts.filter(
          (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
        ),
      ).toEqual(pinnedProviderAttempts);
      expect(finalRows.events).toEqual(corrupted.events);
      expect(targetExecutionObservations).toHaveLength(0);
      expect(result.actionIntent).toBeUndefined();

      const orphanedFailedExecution =
        targetExecution?.settled_at !== null &&
        targetExecution?.settlement_kind === "Failed" &&
        targetStep?.state === "ActionsInProgress" &&
        targetStep.settlement_json === null &&
        targetAction?.state === "Pending" &&
        targetAction.observation_source_ref === null;
      if (orphanedFailedExecution) {
        throw new Error(
          `AH10 binding rejection orphaned a failed Execution: ${JSON.stringify(
            {
              execution: targetExecution,
              step: targetStep,
              action: targetAction,
              observations: targetExecutionObservations,
            },
          )}`,
        );
      }
      expect(orphanedFailedExecution).toBe(false);
      await newDaemon.crash();
    },
    180_000,
  );
});
