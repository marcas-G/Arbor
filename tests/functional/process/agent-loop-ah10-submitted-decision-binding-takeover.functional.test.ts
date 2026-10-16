import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  proposeAndApproveChildWithoutWork,
  submitHumanMessage,
  waitForApproval,
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
  readonly actionIndex?: number;
  readonly failureCode?: string;
  readonly recoveryProbe?: boolean;
  readonly stopRequested?: boolean;
  readonly factPresent?: boolean;
  readonly acquired?: boolean;
  readonly errorTag?: string;
  readonly stage?: string;
  readonly outcome?: "pass" | "blocked";
  readonly reason?: string;
  readonly unresolvedP4Effects?: number;
  readonly resolution?: string;
}

interface Rows {
  readonly leases: Array<{
    execution_id: string;
    generation: number;
    expires_at: string;
  }>;
  readonly commands: Array<{
    command_id: string;
    resolution: string;
    result_json: string | null;
    terminal_error_json: string | null;
  }>;
  readonly decisions: Array<{
    decision_id: string;
    workspace_id: string;
    candidate_work_ids_json: string;
    state: "Pending" | "Submitted";
    selected_work_id: string | null;
    revision: number;
  }>;
  readonly executions: Array<{
    execution_id: string;
    project_id: string;
    workspace_id: string;
    episode_kind: string | null;
    episode_ref: string | null;
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
  readonly actions: Array<{
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
  }>;
  readonly workspaces: Array<{
    workspace_id: string;
    current_work_id: string | null;
    revision: number;
  }>;
  readonly works: Array<{
    work_id: string;
    workspace_id: string;
    objective: string;
    lifecycle: string;
    revision: number;
  }>;
  readonly attempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    settled_at: string | null;
  }>;
  readonly observations: Array<{ source_ref: string; payload_json: string }>;
  readonly events: Array<{
    event_type: string;
    aggregate_ref: string;
    payload_json: string;
  }>;
}

interface BindingFact {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly provider_turn_id: string;
  readonly logical_action_id: string;
  readonly failure_code: string;
  readonly first_detected_at: string;
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
    // Daemon output is retained by the fixture for failure diagnostics.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: "old" | "new",
  gate: string,
) =>
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );

const readRows = (databaseFile: string): Rows => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases ORDER BY execution_id",
        )
        .all() as Rows["leases"],
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands ORDER BY created_at, command_id",
        )
        .all() as Rows["commands"],
      decisions: db
        .prepare(
          `SELECT decision_id, workspace_id, candidate_work_ids_json, state,
                  selected_work_id, revision
             FROM work_selection_decision_requests ORDER BY created_at`,
        )
        .all() as Rows["decisions"],
      executions: db
        .prepare(
          `SELECT execution_id, project_id, workspace_id, episode_kind,
                  episode_ref, settled_at, settlement_kind
             FROM executions ORDER BY admitted_at`,
        )
        .all() as Rows["executions"],
      steps: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id,
                  manifest_id, state, revision, next_action_index, settlement_json
             FROM agent_loop_steps ORDER BY execution_id, logical_step_no, repair_attempt`,
        )
        .all() as Rows["steps"],
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
            ORDER BY a.execution_id, a.logical_step_no, a.repair_attempt, a.action_index`,
        )
        .all() as Rows["actions"],
      workspaces: db
        .prepare(
          "SELECT workspace_id, current_work_id, revision FROM workspaces ORDER BY workspace_id",
        )
        .all() as Rows["workspaces"],
      works: db
        .prepare(
          "SELECT work_id, workspace_id, objective, lifecycle, revision FROM works ORDER BY created_at, work_id",
        )
        .all() as Rows["works"],
      attempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, settled_at FROM provider_attempts ORDER BY provider_turn_id, attempt_no",
        )
        .all() as Rows["attempts"],
      observations: db
        .prepare(
          `SELECT source_ref, payload_json FROM session_entries
            WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'
            ORDER BY sequence`,
        )
        .all() as Rows["observations"],
      events: db
        .prepare(
          `SELECT event_type, aggregate_ref, payload_json
             FROM domain_events ORDER BY sequence`,
        )
        .all() as Rows["events"],
    };
  } finally {
    db.close();
  }
};

const readBindingFacts = (
  databaseFile: string,
  executionId: string,
): BindingFact[] => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT attention_fact_id, event_id, project_id, execution_id,
                workspace_id, logical_step_no, repair_attempt, provider_turn_id,
                logical_action_id, failure_code, first_detected_at
           FROM submitted_decision_binding_attention_facts
          WHERE execution_id = ? ORDER BY attention_fact_id`,
      )
      .all(executionId) as unknown as BindingFact[];
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

const schedulerSelectionWork = (marker: string) => ({
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
  reason: "AH10 process fixture",
});

const selectReceipt = (
  rows: Rows,
  workspaceId: string,
  workId: string,
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
        result.workspaceId === workspaceId &&
        result.workId === workId &&
        result.revision === revision
      );
    } catch {
      return false;
    }
  });

const submitSchedulerWork = async (
  client: ReturnType<typeof makePublicClient>,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
  marker: string,
) => {
  const objective = `Stage Scheduler selection candidates for ${marker}.`;
  await submitHumanMessage(
    client,
    project,
    `Please create the Scheduler selection Work ${marker}.`,
  );
  const approval = await waitForApproval(client, project, marker);
  await client.command(project.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
    capability: "core.control.assign-work",
    target: project.rootWorkspaceId,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "Approve",
    reason: "P41 Scheduler Work seed approval",
  });
  const currentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (work) => work?.workId !== undefined && work.objective === objective,
  );
  if (currentWork?.workId === undefined) {
    throw new Error("public Scheduler Work was not admitted");
  }
  expect(currentWork).toMatchObject({ objective, revision: 0, status: "Open" });
  return currentWork.workId;
};

describe("AH10 P41 Submitted DecisionEpisode binding process recovery", () => {
  it.each([
    { corruption: "workspace", factCommitSide: "before" },
    { corruption: "manifest", factCommitSide: "before" },
    { corruption: "workspace", factCommitSide: "after" },
    { corruption: "manifest", factCommitSide: "after" },
  ] as const)(
    "blocks a $corruption mismatch through gen0→gen1 $factCommitSide-commit kill and gen2 recovery",
    async ({ corruption, factCommitSide }) => {
      const marker = `AH10-P41-${corruption}-${factCommitSide}-${crypto.randomUUID().slice(0, 8)}`;
      const events: Probe[] = [];
      let assignmentsSent = false;
      let waitSent = false;
      let seedWaitSent = false;
      let workspaceReady = false;
      let proposalSent = false;
      let selectionProviderCalls = 0;
      let selectedWorkId: string | undefined;
      const childName = `binding-${marker}`;
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const tools = availableTools(call);
          const messageText = JSON.stringify(call.messages);
          if (
            tools.has("propose_workspace") &&
            messageText.includes(`Propose ${childName}`)
          ) {
            if (proposalSent) {
              return { _tag: "Text", text: `Proposed ${childName}` };
            }
            proposalSent = true;
            return {
              _tag: "ToolCall",
              name: "propose_workspace",
              arguments: {
                name: childName,
                rationale:
                  "form a real alternate Workspace for P41 qualification",
                responsibilityDraft: {
                  purpose: `provide an alternate Workspace for ${marker}`,
                  ownedResponsibilities: [marker],
                  obligations: [],
                  includes: [],
                  excludes: [],
                  interfaces: [],
                },
                resourceBoundaryDraft: {
                  addresses: [
                    { _tag: "FileTree", path: fixture.workspaceDirectory },
                  ],
                },
              },
            };
          }
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
            !tools.has("claim_completion")
          ) {
            return messageText.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Work admitted for ${marker}.` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: schedulerSelectionWork(marker),
                };
          }
          if (
            messageText.includes(marker) &&
            tools.has("claim_completion") &&
            !workspaceReady &&
            !seedWaitSent
          ) {
            seedWaitSent = true;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `hold Scheduler seed until public fixture setup completes for ${marker}`,
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            };
          }
          if (
            messageText.includes(marker) &&
            workspaceReady &&
            tools.has("claim_completion") &&
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
        `AH10 P41 ${corruption} mismatch`,
        { resourceSelection: "Profile" },
      );
      const currentWorkId = await submitSchedulerWork(client, project, marker);
      let foreignWorkspaceId: string | undefined;
      if (corruption === "workspace") {
        const foreignWorkspace = await proposeAndApproveChildWithoutWork(
          client,
          project,
          marker,
          `Propose ${childName} for ${marker}`,
          {
            name: childName,
            rationale: "form a real alternate Workspace for P41 qualification",
            responsibilityDraft: {
              purpose: `provide an alternate Workspace for ${marker}`,
              ownedResponsibilities: [marker],
              obligations: [],
              includes: [],
              excludes: [],
              interfaces: [],
            },
            resourceBoundaryDraft: {
              addresses: [
                { _tag: "FileTree", path: fixture.workspaceDirectory },
              ],
            },
          },
        );
        foreignWorkspaceId = foreignWorkspace.workspaceId;
      }
      workspaceReady = true;
      await client.command(project.projectId, "SteerWork", {
        workId: currentWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: {
          severity: "Normal",
          guidance: `Continue Scheduler selection setup ${marker}.`,
        },
        provenance: { source: "HumanInput" },
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
          "Scheduler did not produce the pinned selection action",
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
      if (request === undefined)
        throw new Error("DecisionRequest row is absent");
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
      if (oldLease === undefined) throw new Error("gen0 lease row is absent");
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

      const actionResultPause = await waitForPublic(
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
      if (actionResultPause === undefined) {
        throw new Error(
          "gen0 did not reach the ActionResult pre-commit boundary",
        );
      }
      const beforeCorruption = readRows(fixture.databaseFile);
      const baseRequest = beforeCorruption.decisions.find(
        (decision) => decision.decision_id === request.decision_id,
      );
      const baseStep = beforeCorruption.steps.find(
        (step) =>
          step.execution_id === oldAction.executionId &&
          step.logical_step_no === 0 &&
          step.repair_attempt === 0 &&
          step.provider_turn_id === oldAction.providerTurnId,
      );
      if (
        baseRequest === undefined ||
        baseStep?.manifest_id === null ||
        baseStep === undefined
      ) {
        throw new Error(
          "Submitted Decision or settled ProviderResult is absent",
        );
      }
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
            throw new Error(
              "public Formation did not create an alternate Workspace",
            );
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
            throw new Error(
              "No second real AgentLoopStep Manifest is available",
            );
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
      expect(corrupted.commands).toEqual(beforeCorruption.commands);
      expect(corrupted.works).toEqual(beforeCorruption.works);
      expect(corrupted.workspaces).toEqual(beforeCorruption.workspaces);
      expect(corrupted.events).toEqual(beforeCorruption.events);
      expect(corrupted.actions).toEqual(beforeCorruption.actions);
      expect(corrupted.observations).toEqual(beforeCorruption.observations);

      // Gen0 has a submitted decision, settled ProviderResult and pending
      // SelectCurrentWork Action. Its SIGKILL precedes ActionResult commit.
      await fixture.crash();
      const afterGen0Kill = readRows(fixture.databaseFile);
      expect(afterGen0Kill.commands).toEqual(corrupted.commands);
      expect(afterGen0Kill.events).toEqual(corrupted.events);
      expect(afterGen0Kill.actions).toEqual(corrupted.actions);
      expect(afterGen0Kill.observations).toEqual(corrupted.observations);
      const gen0Lease = afterGen0Kill.leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      if (gen0Lease === undefined) throw new Error("gen0 lease row is absent");
      await expireExecutionLeaseAfterOwnerExitForQualification({
        databaseFile: fixture.databaseFile,
        executionId: oldAction.executionId,
        expected: {
          generation: Number(gen0Lease.generation),
          expiresAt: gen0Lease.expires_at,
        },
        daemon: {
          crash: fixture.crash,
          snapshot: fixture.daemonProcessSnapshot,
        },
      });

      // Gen1 detects the pinned submitted-decision mismatch and is killed
      // either inside the P9 fact/event transaction or immediately after it.
      const gen1 = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_GATE_ACTION_KIND: "select_current_work",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          ARBOR_WORKSPACE_ID: project.rootWorkspaceId,
          ARBOR_AH10_PAUSE_SUBMITTED_BINDING_FACT: factCommitSide,
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const factBoundary =
        factCommitSide === "before"
          ? "AH10BeforeSubmittedDecisionBindingFactCommit"
          : "AH10AfterSubmittedDecisionBindingFactCommit";
      const factPause = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === factBoundary &&
              event.executionId === oldAction.executionId &&
              event.fencingGeneration === 1,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(factPause?.logicalActionId).toBe(oldAction.logicalActionId);
      const gen1BoundaryRows = readRows(fixture.databaseFile);
      const gen1BoundaryFacts = readBindingFacts(
        fixture.databaseFile,
        oldAction.executionId,
      );
      const gen1BoundaryEvents = gen1BoundaryRows.events.filter(
        (event) =>
          event.event_type === "SubmittedDecisionBindingEscalated" &&
          event.aggregate_ref === project.rootWorkspaceId,
      );
      expect(gen1BoundaryFacts).toHaveLength(
        factCommitSide === "before" ? 0 : 1,
      );
      expect(gen1BoundaryEvents).toHaveLength(
        factCommitSide === "before" ? 0 : 1,
      );
      expect(gen1BoundaryRows.commands).toEqual(corrupted.commands);
      expect(gen1BoundaryRows.decisions).toEqual(corrupted.decisions);
      expect(gen1BoundaryRows.actions).toEqual(corrupted.actions);
      expect(gen1BoundaryRows.observations).toEqual(corrupted.observations);

      await gen1.crash();
      const afterGen1Kill = readRows(fixture.databaseFile);
      expect(
        readBindingFacts(fixture.databaseFile, oldAction.executionId),
      ).toHaveLength(factCommitSide === "before" ? 0 : 1);
      expect(
        afterGen1Kill.events.filter(
          (event) =>
            event.event_type === "SubmittedDecisionBindingEscalated" &&
            event.aggregate_ref === project.rootWorkspaceId,
        ),
      ).toHaveLength(factCommitSide === "before" ? 0 : 1);
      expect(afterGen1Kill.commands).toEqual(corrupted.commands);
      expect(afterGen1Kill.decisions).toEqual(corrupted.decisions);
      expect(afterGen1Kill.actions).toEqual(corrupted.actions);
      expect(afterGen1Kill.observations).toEqual(corrupted.observations);
      const gen1Lease = afterGen1Kill.leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      if (gen1Lease === undefined) throw new Error("gen1 lease row is absent");
      await expireExecutionLeaseAfterOwnerExitForQualification({
        databaseFile: fixture.databaseFile,
        executionId: oldAction.executionId,
        expected: {
          generation: Number(gen1Lease.generation),
          expiresAt: gen1Lease.expires_at,
        },
        daemon: {
          crash: gen1.crash,
          snapshot: gen1.daemonProcessSnapshot,
        },
      });

      // Gen2 must either create the rolled-back fact once or read the exact
      // committed fact without duplicating its event, then remain blocked.
      const gen2 = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_GATE_ACTION_KIND: "select_current_work",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          ARBOR_WORKSPACE_ID: project.rootWorkspaceId,
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const recoveryClient = makePublicClient(gen2.baseUrl);
      const gen2LeaseProbe = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId &&
              event.fencingGeneration === 2,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(gen2LeaseProbe?.fencingGeneration).toBe(2);

      const recovered = await waitForPublic(
        async () => ({
          rows: readRows(fixture.databaseFile),
          facts: readBindingFacts(fixture.databaseFile, oldAction.executionId),
        }),
        ({ facts }) => facts.length === 1,
        20_000,
      ).catch((error: unknown) => {
        throw new Error(
          `gen2 did not persist the P41 fact: ${error instanceof Error ? error.message : String(error)}; gen2Errors=${JSON.stringify(gen2.daemonErrors)}; probes=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; rows=${JSON.stringify(readRows(fixture.databaseFile))}; facts=${JSON.stringify(readBindingFacts(fixture.databaseFile, oldAction.executionId))}`,
        );
      });
      const recoveredAttention = await recoveryClient.view<{
        rows: Array<{
          source: string;
          severity: string;
          targetWorkspaceId: string;
          dedupKey: string;
        }>;
      }>("attention", { projectId: project.projectId });
      expect(recoveredAttention.rows).toContainEqual(
        expect.objectContaining({
          source: "SubmittedDecisionBindingFailure",
          severity: "ActionRequired",
          targetWorkspaceId: project.rootWorkspaceId,
          dedupKey: recovered.facts[0]?.attention_fact_id,
        }),
      );
      const finalRows = recovered.rows;
      const fact = recovered.facts[0];
      expect(recovered.facts).toHaveLength(1);
      expect(fact).toMatchObject({
        execution_id: oldAction.executionId,
        project_id: project.projectId,
        workspace_id: project.rootWorkspaceId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        failure_code:
          corruption === "workspace"
            ? "DecisionRequestWorkspaceMismatch"
            : "StepManifestMismatch",
      });
      expect(
        finalRows.events.filter(
          (event) =>
            event.event_type === "SubmittedDecisionBindingEscalated" &&
            event.aggregate_ref === project.rootWorkspaceId,
        ),
      ).toHaveLength(1);
      expect(
        recoveredAttention.rows.filter(
          (row) =>
            row.source === "SubmittedDecisionBindingFailure" &&
            row.dedupKey === fact?.attention_fact_id,
        ),
      ).toHaveLength(1);

      expect(finalRows.executions).toEqual(corrupted.executions);
      expect(finalRows.steps).toEqual(corrupted.steps);
      expect(finalRows.actions).toEqual(corrupted.actions);
      expect(finalRows.commands).toEqual(corrupted.commands);
      expect(finalRows.decisions).toEqual(corrupted.decisions);
      expect(finalRows.workspaces).toEqual(corrupted.workspaces);
      expect(finalRows.works).toEqual(corrupted.works);
      expect(finalRows.observations).toEqual(corrupted.observations);
      expect(
        finalRows.attempts.filter(
          (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
        ),
      ).toEqual(pinnedProviderAttempts);
      expect(
        selectReceipt(
          finalRows,
          project.rootWorkspaceId,
          selectedWorkId,
          (oldWorkspace?.revision ?? 0) + 1,
        ),
      ).toEqual(originalReceipt);
      expect(selectionProviderCalls).toBe(1);
      expect(gen1.daemonErrors).toEqual([]);
      expect(gen2.daemonErrors).toEqual([]);

      await recoveryClient.command(project.projectId, "StopExecution", {
        executionId: oldAction.executionId,
      });
      await gen2.crash();
      const gen2LeaseRow = readRows(fixture.databaseFile).leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      if (gen2LeaseRow === undefined) {
        throw new Error("gen2 lease row is absent after its process exit");
      }
      await expireExecutionLeaseAfterOwnerExitForQualification({
        databaseFile: fixture.databaseFile,
        executionId: oldAction.executionId,
        expected: {
          generation: Number(gen2LeaseRow.generation),
          expiresAt: gen2LeaseRow.expires_at,
        },
        daemon: {
          crash: gen2.crash,
          snapshot: gen2.daemonProcessSnapshot,
        },
      });
      const gen3 = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_GATE_ACTION_KIND: "select_current_work",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          ARBOR_WORKSPACE_ID: project.rootWorkspaceId,
          ARBOR_AH10_P41_RECOVERY_EXECUTION_ID: oldAction.executionId,
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const stopRecoveryClient = makePublicClient(gen3.baseUrl);
      const stopRecoveryCandidate = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.recoveryProbe === true &&
              event.boundary === "AH10P41RecoveryCandidate" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        15_000,
      );
      expect(stopRecoveryCandidate).toMatchObject({
        stopRequested: true,
        factPresent: true,
      });
      const stopSettlement = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.recoveryProbe === true &&
              event.boundary === "AH10P41StopSettlement" &&
              event.executionId === oldAction.executionId &&
              event.resolution === "Committed",
          ),
        (event) => event !== undefined,
        15_000,
      ).catch((error: unknown) => {
        throw new Error(
          `P41 RecoveryController did not commit Stop settlement: ${error instanceof Error ? error.message : String(error)}; gen3Errors=${JSON.stringify(gen3.daemonErrors)}; recoveryEvents=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId && event.recoveryProbe === true))}; target=${JSON.stringify(readRows(fixture.databaseFile).executions.find((execution) => execution.execution_id === oldAction.executionId))}; lease=${JSON.stringify(readRows(fixture.databaseFile).leases.find((lease) => lease.execution_id === oldAction.executionId))}; fact=${JSON.stringify(readBindingFacts(fixture.databaseFile, oldAction.executionId))}`,
        );
      });
      expect(stopSettlement?.resolution).toBe("Committed");
      const stopped = await waitForPublic(
        async () => ({
          rows: readRows(fixture.databaseFile),
          facts: readBindingFacts(fixture.databaseFile, oldAction.executionId),
          attention: await stopRecoveryClient.view<{
            rows: Array<{
              source: string;
              severity: string;
              targetWorkspaceId: string;
              dedupKey: string;
            }>;
          }>("attention", { projectId: project.projectId }),
        }),
        ({ rows }) =>
          rows.executions.some(
            (execution) =>
              execution.execution_id === oldAction.executionId &&
              execution.settlement_kind === "Interrupted",
          ),
        30_000,
      );
      expect(
        stopped.rows.executions.find(
          (execution) => execution.execution_id === oldAction.executionId,
        ),
      ).toMatchObject({ settlement_kind: "Interrupted" });
      expect(
        stopped.rows.steps.find(
          (step) =>
            step.execution_id === oldAction.executionId &&
            step.logical_step_no === 0 &&
            step.repair_attempt === 0,
        )?.state,
      ).toBe("SettlementProposed");
      expect(
        stopped.rows.actions.find(
          (action) => action.logical_action_id === oldAction.logicalActionId,
        )?.state,
      ).toBe("TerminalRejected");
      expect(stopped.facts).toEqual(recovered.facts);
      expect(
        stopped.attention.rows.filter(
          (row) =>
            row.source === "SubmittedDecisionBindingFailure" &&
            row.dedupKey === fact?.attention_fact_id,
        ),
      ).toHaveLength(1);
      expect(gen3.daemonErrors).toEqual([]);
      await gen3.crash();
    },
    240_000,
  );
});
