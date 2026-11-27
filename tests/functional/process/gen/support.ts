import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import type { ProductionFixture } from "../../support/production-fixture.js";

export interface Ah10Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
  readonly pauseRequested?: boolean;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
}

interface Ah10CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface Ah10DeliverableRow {
  readonly deliverable_id: string;
  readonly source_work_id: string;
  readonly kind: string;
}

interface Ah10DependencyRow {
  readonly dependency_id: string;
  readonly project_id: string;
  readonly consumer_work_id: string;
  readonly producer_binding: string;
  readonly expected_deliverable: string;
  readonly revision: number;
  readonly state: string;
}

interface Ah10AcceptanceRow {
  readonly acceptance_id: string;
  readonly project_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly verification_id: string;
}

interface Ah10ProviderAttemptRow {
  readonly provider_turn_id: string;
  readonly attempt_no: number;
  readonly outcome: string;
  readonly settled_at: string | null;
}

export const fixtures: ProductionFixture[] = [];

export const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});
export const ah10Child = resolve("tests/functional/support/process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

export const pushProbe = (events: Ah10Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Ah10Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Daemon logs are retained by the fixture for failure diagnostics.
  }
};

export const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

export const readAh10Rows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          `SELECT execution_id, worker_id, worker_incarnation_id, generation, expires_at
             FROM execution_leases`,
        )
        .all() as Array<{
        execution_id: string;
        worker_id: string;
        worker_incarnation_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands",
        )
        .all() as unknown as Ah10CommandRow[],
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
      deliverables: db
        .prepare(
          "SELECT deliverable_id, source_work_id, kind FROM deliverables ORDER BY created_at",
        )
        .all() as unknown as Ah10DeliverableRow[],
      dependencies: db
        .prepare(
          `SELECT dependency_id, project_id, consumer_work_id, producer_binding,
                  expected_deliverable, revision, state
             FROM dependencies ORDER BY dependency_id`,
        )
        .all() as unknown as Ah10DependencyRow[],
      acceptances: db
        .prepare(
          `SELECT acceptance_id, project_id, work_id, target_work_revision,
                  verification_id FROM work_acceptances ORDER BY acceptance_id`,
        )
        .all() as unknown as Ah10AcceptanceRow[],
      providerAttempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, settled_at FROM provider_attempts ORDER BY provider_turn_id, attempt_no",
        )
        .all() as unknown as Ah10ProviderAttemptRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.action_index, a.observation_source_ref,
                  a.call_ref, a.action_kind, a.state
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
      domainEvents: db
        .prepare(
          "SELECT sequence, project_id, event_type, aggregate_ref, caused_by_command_id, payload_json FROM domain_events ORDER BY sequence",
        )
        .all() as Array<{
        sequence: number;
        project_id: string;
        event_type: string;
        aggregate_ref: string;
        caused_by_command_id: string | null;
        payload_json: string;
      }>,
      actionObservations: db
        .prepare(
          `SELECT se.entry_kind, se.source_kind, se.source_ref, se.payload_json
             FROM session_entries se
            WHERE se.source_kind = 'AgentLoopAction'
              AND se.entry_kind = 'Observation'
            ORDER BY se.sequence`,
        )
        .all() as Array<{
        entry_kind: string;
        source_kind: string;
        source_ref: string;
        payload_json: string;
      }>,
    };
  } finally {
    db.close();
  }
};
