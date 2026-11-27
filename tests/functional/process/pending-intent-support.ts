import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import type { AhProbeHit } from "../support/ah-probe-line.js";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../support/fixture-failure-evidence.js";
import type {
  ProductionFixture,
  ProviderResponseGate,
} from "../support/production-fixture.js";
import { removeFunctionalFixtureDirectory } from "../support/schema44-bootstrap.js";

export const fixtures: ProductionFixture[] = [];
export const fixturePhases = new Map<
  ProductionFixture,
  {
    readonly boundary: Ah7PendingIntentBoundary;
    projectId?: string;
    workspaceId?: string;
    executionId?: string;
    callRef?: string;
    providerTurnId?: string;
    logicalActionId?: string;
    readonly diagnosticState: () => Readonly<Record<string, unknown>>;
    phase: string;
  }
>();
export const crashChild = resolve(
  "tests/functional/support/ah-crash-child.mjs",
);
export const ah7PendingIntentBoundaries = [
  "AH7AfterActionIntentCommit",
  "AH7AfterToolIntentCommit",
  "AH7BeforeToolSettlementTransaction",
  "AH7BeforeToolSettlementCommit",
  "AH7AfterToolSettlementCommit",
  "AH7BeforeActionResultCommit",
  "AH7AfterActionResultCommit",
] as const;

export const readFailureProjectSnapshot = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly executionId?: string;
  readonly callRef?: string;
}) => {
  const db = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const executionFilter = input.executionId ?? null;
    const sessionEntries = db
      .prepare(
        `SELECT DISTINCT se.sequence, se.session_id, se.payload_json,
                se.source_kind, se.source_ref
           FROM session_entries se JOIN executions e
             ON e.session_id = se.session_id
          WHERE e.project_id = ?
            AND (? IS NULL OR e.execution_id = ?)
            AND se.item_type = 'ToolResult'
          ORDER BY se.session_id, se.sequence`,
      )
      .all(input.projectId, executionFilter, executionFilter) as Array<{
      readonly sequence: number;
      readonly session_id: string;
      readonly payload_json: string;
      readonly source_kind: string | null;
      readonly source_ref: string | null;
    }>;
    const toolResults =
      input.callRef === undefined
        ? sessionEntries
        : sessionEntries.filter((entry) => {
            try {
              const payload: unknown = JSON.parse(entry.payload_json);
              return (
                typeof payload === "object" &&
                payload !== null &&
                "_tag" in payload &&
                payload._tag === "ToolResult" &&
                "callRef" in payload &&
                payload.callRef === input.callRef
              );
            } catch {
              return false;
            }
          });
    const snapshot = {
      projectId: input.projectId,
      executionId: input.executionId ?? null,
      executions: db
        .prepare(
          `SELECT execution_id, project_id, workspace_id, episode_kind,
                  episode_ref, stop_requested_at, settled_at, settlement_kind,
                  settlement_json
             FROM executions WHERE project_id = ? ORDER BY admitted_at`,
        )
        .all(input.projectId),
      workspaces: db
        .prepare(
          `SELECT workspace_id, parent_workspace_id, current_work_id, revision
             FROM workspaces WHERE project_id = ? ORDER BY workspace_id`,
        )
        .all(input.projectId),
      works: db
        .prepare(
          `SELECT w.work_id, w.workspace_id, w.lifecycle, w.revision
             FROM works w JOIN workspaces ws ON ws.workspace_id = w.workspace_id
            WHERE ws.project_id = ? ORDER BY w.created_at, w.work_id`,
        )
        .all(input.projectId),
      decisions: db
        .prepare(
          `SELECT d.decision_id, d.workspace_id, d.candidate_work_ids_json,
                  d.state, d.selected_work_id, d.revision
             FROM work_selection_decision_requests d
             JOIN workspaces ws ON ws.workspace_id = d.workspace_id
            WHERE ws.project_id = ? ORDER BY d.created_at, d.decision_id`,
        )
        .all(input.projectId),
      steps: db
        .prepare(
          `SELECT s.execution_id, s.logical_step_no, s.repair_attempt,
                  s.provider_turn_id, s.manifest_id, s.state, s.revision,
                  s.next_action_index, s.settlement_json
             FROM agent_loop_steps s
             JOIN executions e ON e.execution_id = s.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR s.execution_id = ?)
            ORDER BY s.execution_id, s.logical_step_no, s.repair_attempt`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      actions: db
        .prepare(
          `SELECT a.execution_id, a.logical_step_no, a.repair_attempt,
                  a.action_index, a.logical_action_id, a.call_ref,
                  a.action_kind, a.state, a.result_ref, a.observation_source_ref,
                  a.disposition_json
             FROM agent_loop_step_actions a
             JOIN executions e ON e.execution_id = a.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR a.execution_id = ?)
            ORDER BY a.execution_id, a.logical_step_no, a.repair_attempt,
                     a.action_index`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      toolInvocations: db
        .prepare(
          `SELECT t.invocation_id, t.execution_id, t.workspace_id,
                  t.tool_name, t.tool_version, t.side_effect_semantics,
                  t.arguments_json, t.resolved_regions_json, t.approval_id,
                  t.effect_admission_state, t.recovery_binding_state,
                  t.recovery_binding_sha256, t.settlement_provenance,
                  t.selected_attempt_no, t.selected_fact_id, t.intent_at,
                  t.settled_at, t.settlement_kind, t.settlement_json,
                  t.result_ref, t.observation_format_version,
                  t.observation_sha256
             FROM tool_invocations t
             JOIN executions e ON e.execution_id = t.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR t.execution_id = ?)
            ORDER BY t.execution_id, t.invocation_id`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      providerTurns: db
        .prepare(
          `SELECT p.provider_turn_id, p.execution_id, p.session_id,
                  p.manifest_id, p.settled_at, p.finish_reason
             FROM provider_turns p JOIN executions e
               ON e.execution_id = p.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR p.execution_id = ?)
            ORDER BY p.provider_turn_id`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      attempts: db
        .prepare(
          `SELECT a.provider_turn_id, a.attempt_no, a.outcome, a.settled_at,
                  a.success_evidence_version
             FROM provider_attempts a JOIN provider_turns p
               ON p.provider_turn_id = a.provider_turn_id
             JOIN executions e ON e.execution_id = p.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR p.execution_id = ?)
            ORDER BY a.provider_turn_id, a.attempt_no`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      artifacts: db
        .prepare(
          `SELECT a.artifact_id, a.invocation_id, a.content_hash
             FROM artifacts a JOIN tool_invocations t
               ON t.invocation_id = a.invocation_id
             JOIN executions e ON e.execution_id = t.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR t.execution_id = ?)
            ORDER BY a.artifact_id`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      toolResults,
      events: db
        .prepare(
          `SELECT event_id, project_id, sequence, event_type, aggregate_ref,
                  payload_json, occurred_at
             FROM domain_events WHERE project_id = ? ORDER BY sequence`,
        )
        .all(input.projectId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original diagnostic snapshot error.
    }
    throw error;
  } finally {
    db.close();
  }
};
export type Ah7PendingIntentBoundary =
  (typeof ah7PendingIntentBoundaries)[number];
export type Ah7CrashSnapshotExpectation = {
  readonly actionState: "Pending" | "Applied";
  readonly actionCursor: 0 | 1;
  readonly p4Intent: "Absent" | "Pending" | "Success" | "ExpectedFailure";
  readonly toolResultCount: 0 | 1;
  readonly artifactCount: 0 | 1;
  readonly probeIdentity: "Action" | "Invocation";
  readonly timeoutMs: 120_000 | 180_000;
};
export const ah7CrashSnapshotExpectations = {
  AH7AfterActionIntentCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Absent",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Action",
    timeoutMs: 120_000,
  },
  AH7AfterToolIntentCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Pending",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Invocation",
    timeoutMs: 120_000,
  },
  AH7BeforeToolSettlementTransaction: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Pending",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Invocation",
    timeoutMs: 180_000,
  },
  AH7BeforeToolSettlementCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Pending",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Invocation",
    timeoutMs: 180_000,
  },
  AH7AfterToolSettlementCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Success",
    toolResultCount: 0,
    artifactCount: 1,
    probeIdentity: "Invocation",
    timeoutMs: 120_000,
  },
  AH7BeforeActionResultCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Success",
    toolResultCount: 0,
    artifactCount: 1,
    probeIdentity: "Action",
    timeoutMs: 120_000,
  },
  AH7AfterActionResultCommit: {
    actionState: "Applied",
    actionCursor: 1,
    p4Intent: "Success",
    toolResultCount: 1,
    artifactCount: 1,
    probeIdentity: "Action",
    timeoutMs: 120_000,
  },
} satisfies Record<Ah7PendingIntentBoundary, Ah7CrashSnapshotExpectation>;
export const ah7PendingIntentScenarios = [
  ...ah7PendingIntentBoundaries.map((boundary) => ({
    boundary,
    expectedSettlement: "Success" as const,
  })),
  {
    boundary: "AH7AfterToolSettlementCommit",
    expectedSettlement: "ExpectedFailure" as const,
  },
] as const;
export interface RawP4InvocationRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly resolved_regions_json: string;
  readonly approval_id: string | null;
  readonly effect_admission_state: string;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly settlement_provenance: string | null;
  readonly selected_attempt_no: number | null;
  readonly selected_fact_id: string | null;
  readonly intent_at: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly result_ref: string | null;
  readonly observation_format_version: string | null;
  readonly observation_json: Uint8Array | null;
  readonly observation_sha256: string | null;
}

export const readRawP4InvocationRows = (
  databaseFile: string,
  executionId: string,
): ReadonlyArray<RawP4InvocationRow> => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT * FROM tool_invocations WHERE execution_id = ? ORDER BY invocation_id",
      )
      .all(executionId) as unknown as ReadonlyArray<RawP4InvocationRow>;
  } finally {
    db.close();
  }
};

export const p4ImmutableBinding = (row: RawP4InvocationRow) => ({
  invocationId: row.invocation_id,
  executionId: row.execution_id,
  workspaceId: row.workspace_id,
  toolName: row.tool_name,
  toolVersion: row.tool_version,
  sideEffectSemantics: row.side_effect_semantics,
  argumentsJson: row.arguments_json,
  resolvedRegionsJson: row.resolved_regions_json,
  approvalId: row.approval_id,
  intentAt: row.intent_at,
});
export interface Ah7ProbeState {
  activePhase: string | undefined;
  activeExecutionId: string | undefined;
  activeDiagnosticTimer: ReturnType<typeof setTimeout> | undefined;
}

export const pendingIntentProbeState: Ah7ProbeState = {
  activePhase: undefined,
  activeExecutionId: undefined,
  activeDiagnosticTimer: undefined,
};

afterEach(async ({ task }) => {
  if (pendingIntentProbeState.activeDiagnosticTimer !== undefined) {
    clearTimeout(pendingIntentProbeState.activeDiagnosticTimer);
    pendingIntentProbeState.activeDiagnosticTimer = undefined;
  }
  pendingIntentProbeState.activePhase = undefined;
  pendingIntentProbeState.activeExecutionId = undefined;
  const failed = (task.result?.errors?.length ?? 0) > 0;
  for (const fixture of fixtures.splice(0)) {
    let stopError: unknown;
    try {
      await fixture.stop();
    } catch (error) {
      stopError = error;
    }
    const phase = fixturePhases.get(fixture);
    fixturePhases.delete(fixture);
    if (!fixture.daemonsExited()) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      if (resultDirectory === undefined) {
        throw new Error(
          `AH7 archive skipped because a daemon may still be active; result directory unavailable; database=${fixture.databaseFile}`,
          { cause: stopError },
        );
      }
      const skippedPath = writeProductionFixtureArchiveSkipped({
        fixture,
        resultDirectory,
        evidence: {
          testName: task.name,
          boundary: phase?.boundary ?? "unknown",
          phase: phase?.phase ?? "unknown",
          stopFailed: stopError !== undefined,
          startupDiagnostics: fixture.startupDiagnostics(),
          daemonErrors: fixture.daemonErrors,
        },
      });
      process.stdout.write(
        `[AH7_ARCHIVE_SKIPPED] ${JSON.stringify({ testName: task.name, databaseFile: fixture.databaseFile, skippedPath })}\n`,
      );
      if (stopError === undefined) {
        throw new Error(
          `AH7 fixture cleanup returned while a daemon may still be active; database=${fixture.databaseFile}`,
        );
      }
    } else if (failed || stopError !== undefined) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      if (resultDirectory === undefined) {
        throw new Error(
          `AH7 failure evidence cannot be archived without ARBOR_TEST_RESULT_DIRECTORY; database=${fixture.databaseFile}`,
          { cause: stopError },
        );
      }
      let snapshot: unknown;
      try {
        snapshot =
          phase?.projectId === undefined
            ? { snapshotUnavailable: "project not yet created" }
            : readFailureProjectSnapshot({
                databaseFile: fixture.databaseFile,
                projectId: phase.projectId,
                ...(phase.callRef === undefined
                  ? {}
                  : { callRef: phase.callRef }),
                ...(phase.executionId === undefined
                  ? {}
                  : { executionId: phase.executionId }),
              });
      } catch (error) {
        snapshot = {
          snapshotError: error instanceof Error ? error.message : String(error),
        };
      }
      const archivedDirectory = archiveProductionFixtureFailure({
        fixture,
        resultDirectory,
        artifactPrefix: "ah7-pending-intent",
        evidence: {
          testName: task.name,
          boundary: phase?.boundary ?? "unknown",
          phase: phase?.phase ?? "unknown",
          projectId: phase?.projectId ?? null,
          workspaceId: phase?.workspaceId ?? null,
          executionId: phase?.executionId ?? null,
          callRef: phase?.callRef ?? null,
          providerTurnId: phase?.providerTurnId ?? null,
          logicalActionId: phase?.logicalActionId ?? null,
          diagnosticState: phase?.diagnosticState() ?? {},
          primaryDaemon: fixture.daemonProcessSnapshot(),
          startupDiagnostics: fixture.startupDiagnostics(),
          daemonErrors: fixture.daemonErrors,
          snapshot,
          stopFailed: stopError !== undefined,
        },
      });
      process.stdout.write(
        `[AH7_FAILURE_ARTIFACT] ${JSON.stringify({ testName: task.name, boundary: phase?.boundary ?? "unknown", phase: phase?.phase ?? "unknown", archivedDirectory })}\n`,
      );
    } else {
      removeFunctionalFixtureDirectory(fixture.directory);
    }
    if (stopError !== undefined) throw stopError;
  }
});

// The seed daemon dispatches the newly approved Work inside the same wake
// loop that settled the approving conversation, so the 10-second seed tick
// cannot keep it away from the provider. Hold the pre-probe Work-turn request
// without writing any response bytes: the seed is then killed with the
// request still pending, every durable replay fact stays false, and restart
// recovery retries the same ProviderTurn under the armed probe. Answering
// that request instead — even with a transport failure — persists
// responseStarted=true, recovery stops the turn fail-closed and the terminal
// ProviderFailure settlement puts the Work behind the same-revision
// readmission hold, which by contract stays blocked across ticks and
// restarts until the user retries.
export const holdPendingIntentSeedWorkTurn =
  (getProbeArmed: () => boolean): ProviderResponseGate =>
  async (call) => {
    const available = new Set(
      call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined),
    );
    if (!available.has("read") || getProbeArmed()) return undefined;
    await new Promise<void>((resolveHold) => {
      const deadline = Date.now() + 30_000;
      const poll = () => {
        if (getProbeArmed() || Date.now() >= deadline) resolveHold();
        else setTimeout(poll, 50);
      };
      poll();
    });
    return undefined;
  };

export const armPendingIntentBoundaryDiagnostics = (input: {
  readonly boundary: Ah7PendingIntentBoundary;
  readonly fixture: ProductionFixture;
  readonly probeState: Ah7ProbeState;
  readonly readTargetProviderCalls: () => number;
}): void => {
  input.probeState.activeDiagnosticTimer = setTimeout(() => {
    let snapshot: unknown = "<snapshot unavailable>";
    try {
      const durable = durableSnapshot(input.fixture.databaseFile);
      snapshot = {
        executions: durable.executions,
        steps:
          input.probeState.activeExecutionId === undefined
            ? durable.steps
            : durable.steps.filter(
                (step) =>
                  step.execution_id === input.probeState.activeExecutionId,
              ),
        actions:
          input.probeState.activeExecutionId === undefined
            ? durable.actions
            : durable.actions.filter(
                (action) =>
                  action.execution_id === input.probeState.activeExecutionId,
              ),
        toolInvocations:
          input.probeState.activeExecutionId === undefined
            ? durable.toolInvocations
            : durable.toolInvocations.filter(
                (invocation) =>
                  invocation.execution_id ===
                  input.probeState.activeExecutionId,
              ),
      };
    } catch (error) {
      snapshot = error instanceof Error ? error.message : String(error);
    }
    console.error(
      `AH7 ${input.boundary} diagnostic: ${JSON.stringify({
        phase: input.probeState.activePhase,
        executionId: input.probeState.activeExecutionId ?? null,
        providerCalls: input.readTargetProviderCalls(),
        daemonErrors: input.fixture.daemonErrors,
        daemon: input.fixture.daemonProcessSnapshot(),
        snapshot,
      })}`,
    );
  }, 90_000);
};

export const pendingIntentRecoveryReached =
  (
    hit: AhProbeHit | undefined,
    logicalActionId: string,
    expectedSettlement: "Success" | "ExpectedFailure",
    expectedCrash: Ah7CrashSnapshotExpectation,
  ) =>
  (value: ReturnType<typeof durableSnapshot>) => {
    const actions = value.actions.filter(
      (action) => action.execution_id === hit?.executionId,
    );
    const invocations = value.toolInvocations.filter(
      (invocation) => invocation.execution_id === hit?.executionId,
    );
    const toolResults = value.toolResults.filter((result) =>
      JSON.stringify(result).includes(hit?.callRef ?? ""),
    );
    const invocationId = invocations[0]?.invocation_id;
    const artifacts = value.artifacts.filter(
      (artifact) => artifact.invocation_id === invocationId,
    );
    return (
      actions.length === 1 &&
      actions[0]?.logical_action_id === logicalActionId &&
      actions[0]?.call_ref === hit?.callRef &&
      actions[0]?.state === "Applied" &&
      invocations.length === 1 &&
      invocations[0]?.tool_name === "read" &&
      invocations[0]?.settlement_kind === expectedSettlement &&
      (expectedSettlement === "ExpectedFailure"
        ? invocations[0]?.result_ref === null && artifacts.length === 0
        : invocations[0]?.result_ref === artifacts[0]?.artifact_id &&
          artifacts.length === 1) &&
      toolResults.length === 1 &&
      (expectedCrash.actionState !== "Applied" ||
        value.steps.some(
          (step) =>
            step.execution_id === hit?.executionId &&
            step.state !== "ActionsInProgress",
        ))
    );
  };
