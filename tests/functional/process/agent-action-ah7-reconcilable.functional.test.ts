import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_DEFINITION } from "../../../packages/tool-runtime/src/catalog.js";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
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
  waitForExecutableApproval,
  waitForPublic,
} from "../support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../support/schema44-bootstrap.js";
import {
  commitTrustedLocalP11Policy,
  createTrustedLocalP11FixtureEnvironment,
  grantTrustedLocalP11Permission,
  initializeTrustedLocalP11Worktree,
} from "../support/trusted-local-p11-fixture.js";

const fixtures: ProductionFixture[] = [];
const preservedTakeoverFailureFixtures = new Set<ProductionFixture>();
const takeoverFailureDiagnostic = new Map<
  ProductionFixture,
  () => Readonly<Record<string, unknown>>
>();
// This bounds the test's wait for a paused child-process source call to return;
// it is not the duration or acceptance deadline for a reconciliation result.
const AH7_CROSS_PROCESS_SOURCE_IO_OBSERVATION_BUDGET_MS = 60_000;
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const reconciliationChild = resolve(
  "tests/functional/support/ah10-process-child.mjs",
);

const readExecutionProviderTurns = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const execution = db
      .prepare(
        "SELECT execution_id, episode_kind, episode_ref FROM executions WHERE execution_id = ?",
      )
      .get(executionId) as
      | {
          execution_id: string;
          episode_kind: string;
          episode_ref: string;
        }
      | undefined;
    const providerTurns = db
      .prepare(
        "SELECT provider_turn_id, execution_id, settled_at, finish_reason FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
      )
      .all(executionId) as Array<{
      provider_turn_id: string;
      execution_id: string;
      settled_at: string | null;
      finish_reason: string | null;
    }>;
    return { execution, providerTurns };
  } finally {
    db.close();
  }
};

const isToolResultFor = (
  row: Readonly<Record<string, unknown>>,
  invocationId: string,
  callRef: string,
): boolean => {
  try {
    const payload = JSON.parse(String(row.payload_json)) as {
      readonly invocationId?: unknown;
      readonly callRef?: unknown;
    };
    return payload.invocationId === invocationId && payload.callRef === callRef;
  } catch {
    return false;
  }
};

const readToolResultForCall = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  callRef: string,
) =>
  rows
    .map((row) => {
      try {
        return {
          row,
          payload: JSON.parse(String(row.payload_json)) as Record<
            string,
            unknown
          >,
        };
      } catch {
        return undefined;
      }
    })
    .find((candidate) => candidate?.payload.callRef === callRef);

interface ExecutableApprovalQualification {
  readonly approvalId: string;
  readonly revision: number;
  readonly row: {
    readonly approval_id: string;
    readonly route_kind: string;
    readonly project_id: string;
    readonly workspace_id: string;
    readonly execution_id: string;
    readonly subject_ref: string;
    readonly stable_action_id: string;
    readonly action_version: string;
    readonly side_effect_semantics: string;
    readonly arguments_json: string;
    readonly target_resource_space_ids_json: string;
    readonly control_basis_digest: string;
    readonly state: string;
    readonly revision: number;
    readonly binding_proven: number;
    readonly logical_step_no: number;
    readonly repair_attempt: number;
    readonly action_index: number;
    readonly logical_action_id: string;
    readonly call_ref: string;
    readonly tool_invocation_id: string;
    readonly episode_kind: string | null;
    readonly episode_ref: string | null;
    readonly episode_revision: number | null;
    readonly action_state: string;
    readonly action_kind: string;
    readonly action_call_ref: string;
    readonly input_hash: string;
  };
}

const waitForExactShellApproval = async (input: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workId: string;
  readonly controlApprovalId: string;
  readonly marker: string;
  readonly command: string;
  readonly sideEffectSemantics: string;
  readonly timeoutMs?: number;
}): Promise<ExecutableApprovalQualification> => {
  const publicEntry = await waitForExecutableApproval(
    input.client,
    input.workspaceId,
    input.marker,
    input.timeoutMs ?? 60_000,
  );
  const { approvalId, revision } = publicEntry;
  const db = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT a.approval_id, a.route_kind, a.project_id, a.workspace_id,
                a.subject_ref,
                a.execution_id, a.stable_action_id, a.action_version,
                a.side_effect_semantics, a.arguments_json,
                a.target_resource_space_ids_json, a.control_basis_digest,
                a.state, a.revision,
                a.binding_proven, a.logical_step_no, a.repair_attempt,
                a.action_index, a.logical_action_id, a.call_ref,
                a.tool_invocation_id, e.episode_kind, e.episode_ref,
                e.episode_revision, x.state AS action_state,
                x.action_kind, x.call_ref AS action_call_ref, x.input_hash
           FROM action_approvals a
           JOIN executions e ON e.execution_id = a.execution_id
           JOIN agent_loop_step_actions x
             ON x.execution_id = a.execution_id
            AND x.logical_step_no = a.logical_step_no
            AND x.repair_attempt = a.repair_attempt
            AND x.action_index = a.action_index
            AND x.logical_action_id = a.logical_action_id
          WHERE a.approval_id = ? AND a.route_kind = 'Executable'
            AND a.binding_proven = 1`,
      )
      .get(approvalId) as ExecutableApprovalQualification["row"] | undefined;
    if (row === undefined) {
      throw new Error(
        `AH7 public EAP ${approvalId} had no exact durable P38 binding`,
      );
    }
    const expectedArguments = {
      command: input.command,
      cwd: { mount: "workspace", path: "." },
      timeoutMs: 5_000,
    };
    expect(row).toMatchObject({
      approval_id: approvalId,
      route_kind: "Executable",
      project_id: input.projectId,
      workspace_id: input.workspaceId,
      subject_ref: "runtime:system",
      stable_action_id: "shell",
      action_version: SHELL_DEFINITION.version,
      side_effect_semantics: input.sideEffectSemantics,
      control_basis_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      state: "Pending",
      revision,
      binding_proven: 1,
      episode_kind: "WorkEpisode",
      episode_ref: input.workId,
      episode_revision: 1,
      action_state: "Pending",
      action_kind: "shell",
      action_call_ref: row.call_ref,
      input_hash: createHash("sha256").update(row.arguments_json).digest("hex"),
    });
    expect(JSON.parse(row.arguments_json)).toEqual(expectedArguments);
    const targetResourceSpaceIds = JSON.parse(
      row.target_resource_space_ids_json,
    ) as unknown;
    expect(targetResourceSpaceIds).toEqual(["filesystem"]);
    expect(row.logical_action_id).toMatch(/^lac_/u);
    expect(row.call_ref).toMatch(/^call_/u);
    expect(row.tool_invocation_id).toMatch(/^tin_/u);
    const executableApprovalCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM action_approvals
              WHERE execution_id = ? AND route_kind = 'Executable'
                AND binding_proven = 1`,
          )
          .get(row.execution_id) as { readonly count: number }
      ).count,
    );
    const controlApproval = db
      .prepare("SELECT route_kind FROM action_approvals WHERE approval_id = ?")
      .get(input.controlApprovalId) as
      | { readonly route_kind: string }
      | undefined;
    expect(executableApprovalCount).toBe(1);
    expect(controlApproval).toEqual({ route_kind: "Control" });
    expect(input.controlApprovalId).not.toBe(approvalId);
    return { approvalId, revision, row };
  } finally {
    db.close();
  }
};

const readExecutableApprovalAfterRecovery = (
  databaseFile: string,
  approvalId: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const approval = db
      .prepare(
        `SELECT approval_id, route_kind, execution_id, state, revision,
                consumed_at, consumed_by, tool_invocation_id, expires_at,
                target_resource_space_ids_json
           FROM action_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as
      | {
          readonly approval_id: string;
          readonly route_kind: string;
          readonly execution_id: string;
          readonly state: string;
          readonly revision: number;
          readonly consumed_at: string | null;
          readonly consumed_by: string | null;
          readonly tool_invocation_id: string;
          readonly expires_at: string | null;
          readonly target_resource_space_ids_json: string;
        }
      | undefined;
    const approvals = db
      .prepare(
        `SELECT approval_id, state, consumed_by FROM action_approvals
          WHERE execution_id = ? AND route_kind = 'Executable'
            AND binding_proven = 1`,
      )
      .all(executionId) as Array<{
      readonly approval_id: string;
      readonly state: string;
      readonly consumed_by: string | null;
    }>;
    if (approval === undefined) throw new Error("AH7 EAP row disappeared");
    return { approval, approvals };
  } finally {
    db.close();
  }
};

const readProjectActiveGrantCount = (
  databaseFile: string,
  executionId: string,
): number => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM permission_grants
              WHERE project_id = (
                SELECT project_id FROM executions WHERE execution_id = ?
              ) AND state = 'Active'`,
          )
          .get(executionId) as { readonly count: number }
      ).count,
    );
  } finally {
    db.close();
  }
};

const readP4InvocationApprovalBinding = (
  databaseFile: string,
  executionId: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT invocation_id, execution_id, workspace_id, tool_name,
                tool_version, side_effect_semantics, arguments_json,
                resolved_regions_json, approval_id, effect_admission_state,
                result_ref, settlement_kind, settled_at,
                settlement_json,
                recovery_binding_sha256, settlement_provenance,
                selected_attempt_no, selected_fact_id,
                observation_format_version, observation_json,
                observation_sha256
           FROM tool_invocations WHERE execution_id = ? AND invocation_id = ?`,
      )
      .get(executionId, invocationId) as
      | {
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
          readonly result_ref: string | null;
          readonly settlement_kind: string | null;
          readonly settled_at: string | null;
          readonly settlement_json: string | null;
          readonly recovery_binding_sha256: string | null;
          readonly settlement_provenance: string | null;
          readonly selected_attempt_no: number | null;
          readonly selected_fact_id: string | null;
          readonly observation_format_version: string | null;
          readonly observation_json: Uint8Array | null;
          readonly observation_sha256: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
};

const readP39RecoveryBinding = (databaseFile: string, invocationId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT canonical_binding_json, binding_sha256
           FROM tool_invocation_recovery_bindings
          WHERE invocation_id = ?`,
      )
      .get(invocationId) as
      | {
          readonly canonical_binding_json: string;
          readonly binding_sha256: string;
        }
      | undefined;
  } finally {
    db.close();
  }
};

const readReconciliationFacts = (
  databaseFile: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT fact_id, attempt_no, outcome, reason_code, evidence_ref,
                result_ref, fact_disposition
           FROM tool_reconciliation_facts WHERE invocation_id = ?
          ORDER BY attempt_no, fact_id`,
      )
      .all(invocationId) as Array<{
      readonly fact_id: string;
      readonly attempt_no: number;
      readonly outcome: string;
      readonly reason_code: string | null;
      readonly evidence_ref: string | null;
      readonly result_ref: string | null;
      readonly fact_disposition: string;
    }>;
  } finally {
    db.close();
  }
};

const readEffectAttempts = (databaseFile: string, invocationId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT attempt_no, admission_state, effect_key, profile_id,
                profile_version, profile_hash, binding_sha256
           FROM tool_invocation_effect_attempts WHERE invocation_id = ?
          ORDER BY attempt_no`,
      )
      .all(invocationId) as Array<{
      readonly attempt_no: number;
      readonly admission_state: string;
      readonly effect_key: string | null;
      readonly profile_id: string | null;
      readonly profile_version: string | null;
      readonly profile_hash: string | null;
      readonly binding_sha256: string;
    }>;
  } finally {
    db.close();
  }
};

const readTestExternalEffects = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT effect_key, result_ref FROM ah7_test_external_effects ORDER BY effect_key",
      )
      .all() as Array<{
      readonly effect_key: string;
      readonly result_ref: string | null;
    }>;
  } finally {
    db.close();
  }
};

const readTestReconciliationCallCount = (
  databaseFile: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ah7_test_reconciliation_calls'",
      )
      .get();
    if (table === undefined) return 0;
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM ah7_test_reconciliation_calls WHERE invocation_id = ?",
        )
        .get(invocationId) as { readonly count: number }
    ).count;
  } finally {
    db.close();
  }
};

const readTestReconciliationCalls = (
  databaseFile: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT call_no, invocation_id, attempt_no, role, observed_effect
           FROM ah7_test_reconciliation_calls
          WHERE invocation_id = ? ORDER BY call_no`,
      )
      .all(invocationId) as Array<Readonly<Record<string, unknown>>>;
  } finally {
    db.close();
  }
};

const readTestReconciliationSourceReturns = (
  gateDirectory: string,
  invocationId: string,
) => {
  const sourceReturnsFile = join(
    gateDirectory,
    "reconciliation-source-returns.jsonl",
  );
  if (!existsSync(sourceReturnsFile)) return [];
  return readFileSync(sourceReturnsFile, "utf8")
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      if (line.length === 0) return [];
      let record: Readonly<Record<string, unknown>>;
      try {
        record = JSON.parse(line) as Readonly<Record<string, unknown>>;
      } catch (error) {
        throw new Error(
          `Invalid AH7 reconciliation JSONL record at line ${index + 1}: ${line}`,
          { cause: error },
        );
      }
      return record.invocationId === invocationId ? [record] : [];
    });
};

const findExactSourceReturn = (
  gateDirectory: string,
  invocationId: string,
  role: "old" | "new",
  attemptNo: number,
  observedEffect: number,
) =>
  readTestReconciliationSourceReturns(gateDirectory, invocationId).filter(
    (row) => {
      const expectedGatePath = join(
        gateDirectory,
        `${role}-reconciliation-io.release`,
      );
      return (
        row.kind === "returned" &&
        row.invocationId === invocationId &&
        row.role === role &&
        Number(row.attemptNo) === attemptNo &&
        Number(row.observedEffect) === observedEffect &&
        typeof row.pid === "number" &&
        typeof row.callNo === "number" &&
        typeof row.timestamp === "string" &&
        row.gatePath === expectedGatePath
      );
    },
  );

const waitForReconciliationSourceReturn = async (
  gateDirectory: string,
  databaseFile: string,
  invocationId: string,
  role: "old" | "new",
  attemptNo: number,
  observedEffect: number,
) => {
  const startedAt = Date.now();
  let records: Array<Readonly<Record<string, unknown>>>;
  const expectedGatePath = join(
    gateDirectory,
    `${role}-reconciliation-io.release`,
  );
  try {
    records = await waitForPublic(
      async () =>
        readTestReconciliationSourceReturns(gateDirectory, invocationId),
      (rows) =>
        rows.some(
          (row) =>
            row.kind === "returned" &&
            row.invocationId === invocationId &&
            row.role === role &&
            Number(row.attemptNo) === attemptNo &&
            Number(row.observedEffect) === observedEffect &&
            typeof row.pid === "number" &&
            typeof row.callNo === "number" &&
            typeof row.timestamp === "string" &&
            row.gatePath === expectedGatePath,
        ),
      AH7_CROSS_PROCESS_SOURCE_IO_OBSERVATION_BUDGET_MS,
    );
  } catch (error) {
    let lastDatabaseRows: Array<Readonly<Record<string, unknown>>> | string;
    try {
      lastDatabaseRows = readTestReconciliationCalls(
        databaseFile,
        invocationId,
      );
    } catch (readError) {
      lastDatabaseRows =
        readError instanceof Error ? readError.message : String(readError);
    }
    throw new Error(
      `AH7 ${role} source-I/O side-channel observation exceeded ${AH7_CROSS_PROCESS_SOURCE_IO_OBSERVATION_BUDGET_MS}ms; elapsedMs=${Date.now() - startedAt}; invocationId=${invocationId}; sideChannel=${JSON.stringify(readTestReconciliationSourceReturns(gateDirectory, invocationId))}; auxiliaryDatabaseRows=${JSON.stringify(lastDatabaseRows)}`,
      { cause: error },
    );
  }
  const elapsedMs = Date.now() - startedAt;
  const matchedReturns = records.filter(
    (row) =>
      row.kind === "returned" &&
      row.invocationId === invocationId &&
      row.role === role &&
      Number(row.attemptNo) === attemptNo &&
      Number(row.observedEffect) === observedEffect &&
      typeof row.pid === "number" &&
      typeof row.callNo === "number" &&
      typeof row.timestamp === "string" &&
      row.gatePath === expectedGatePath,
  );
  process.stdout.write(
    `${JSON.stringify({
      tag: "AH7_SOURCE_IO_RETURN_OBSERVED",
      invocationId,
      role,
      elapsedMs,
      observationBudgetMs: AH7_CROSS_PROCESS_SOURCE_IO_OBSERVATION_BUDGET_MS,
      sourceReturns: matchedReturns,
      sideChannel: records,
    })}\n`,
  );
  expect(matchedReturns).toHaveLength(1);
  return { records, sourceReturn: matchedReturns[0], elapsedMs };
};

const waitForOldReconciliationCallReturn = (
  gateDirectory: string,
  databaseFile: string,
  invocationId: string,
) =>
  waitForReconciliationSourceReturn(
    gateDirectory,
    databaseFile,
    invocationId,
    "old",
    0,
    0,
  );

const readAh7FailureSnapshot = (
  databaseFile: string,
  identity: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly executionId: string;
    readonly invocationId: string;
  },
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  const snapshotReadErrors: string[] = [];
  const rows = (
    sql: string,
    ...parameters: Array<string | number | null>
  ): Array<Readonly<Record<string, unknown>>> => {
    try {
      return db.prepare(sql).all(...parameters) as Array<
        Readonly<Record<string, unknown>>
      >;
    } catch (error) {
      snapshotReadErrors.push(
        `${sql}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  };
  try {
    db.exec("BEGIN");
    const snapshot = {
      executions: rows(
        "SELECT * FROM executions WHERE execution_id = ?",
        identity.executionId,
      ),
      leases: rows(
        "SELECT * FROM execution_leases WHERE execution_id = ?",
        identity.executionId,
      ),
      agentExecutionState: rows(
        "SELECT * FROM agent_execution_state WHERE execution_id = ?",
        identity.executionId,
      ),
      providerTurns: rows(
        "SELECT * FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
        identity.executionId,
      ),
      providerAttempts: rows(
        `SELECT * FROM provider_attempts
          WHERE provider_turn_id IN (
            SELECT provider_turn_id FROM provider_turns WHERE execution_id = ?
          ) ORDER BY provider_turn_id, attempt_no`,
        identity.executionId,
      ),
      steps: rows(
        "SELECT * FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no, repair_attempt",
        identity.executionId,
      ),
      actionInvocations: rows(
        "SELECT * FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY logical_step_no, repair_attempt, action_index",
        identity.executionId,
      ),
      p4InvocationIntentsAndSettlements: rows(
        "SELECT * FROM tool_invocations WHERE execution_id = ? AND invocation_id = ?",
        identity.executionId,
        identity.invocationId,
      ),
      p39RecoveryBindings: rows(
        "SELECT * FROM tool_invocation_recovery_bindings WHERE invocation_id = ?",
        identity.invocationId,
      ),
      p4EffectAttempts: rows(
        "SELECT * FROM tool_invocation_effect_attempts WHERE invocation_id = ? ORDER BY attempt_no",
        identity.invocationId,
      ),
      p4ReconciliationFacts: rows(
        "SELECT * FROM tool_reconciliation_facts WHERE invocation_id = ? ORDER BY attempt_no, fact_id",
        identity.invocationId,
      ),
      p4ReconciliationSourceCalls: rows(
        "SELECT * FROM ah7_test_reconciliation_calls WHERE invocation_id = ? ORDER BY call_no",
        identity.invocationId,
      ),
      sessionResultsAndObservations: rows(
        `SELECT * FROM session_entries
          WHERE session_id = (
            SELECT session_id FROM executions WHERE execution_id = ?
          ) AND item_type IN ('ToolCall','ToolResult','Observation','ControlResult')
          ORDER BY sequence`,
        identity.executionId,
      ),
      executableApprovals: rows(
        "SELECT * FROM action_approvals WHERE execution_id = ?",
        identity.executionId,
      ),
      inboxEntries: rows(
        "SELECT * FROM inbox_entries WHERE workspace_id = ? ORDER BY admitted_at, entry_key",
        identity.workspaceId,
      ),
      commandReceipts: rows(
        "SELECT * FROM commands WHERE project_id = ? ORDER BY created_at, command_id",
        identity.projectId,
      ),
      commandAttempts: rows(
        `SELECT * FROM command_attempts
          WHERE command_id IN (SELECT command_id FROM commands WHERE project_id = ?)
          ORDER BY command_id, attempt_no`,
        identity.projectId,
      ),
      domainEvents: rows(
        `SELECT * FROM domain_events
          WHERE project_id = ? AND (aggregate_ref = ? OR aggregate_ref = ?)
          ORDER BY sequence`,
        identity.projectId,
        identity.executionId,
        identity.invocationId,
      ),
      snapshotReadErrors,
      attentionTables: (() => {
        const tableNames = rows(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%attention%' ORDER BY name`,
        ).map((row) => String(row.name));
        return tableNames.map((tableName) => {
          const escapedTable = tableName.replaceAll('"', '""');
          const columns = rows(`PRAGMA table_info("${escapedTable}")`)
            .map((row) => String(row.name))
            .filter((name) =>
              [
                "project_id",
                "workspace_id",
                "execution_id",
                "invocation_id",
              ].includes(name),
            );
          const filters = columns
            .map((column) => {
              const value =
                column === "project_id"
                  ? identity.projectId
                  : column === "workspace_id"
                    ? identity.workspaceId
                    : column === "execution_id"
                      ? identity.executionId
                      : identity.invocationId;
              return { column, value };
            })
            .filter(({ value }) => value !== undefined);
          if (filters.length === 0) return { tableName, rows: [] };
          const where = filters
            .map(({ column }) => `"${column}" = ?`)
            .join(" OR ");
          return {
            tableName,
            rows: rows(
              `SELECT * FROM "${escapedTable}" WHERE ${where}`,
              ...filters.map(({ value }) => value),
            ),
          };
        });
      })(),
      externalEffects: rows(
        "SELECT * FROM ah7_test_external_effects ORDER BY effect_key",
      ),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the read failure as the diagnostic result.
    }
    return {
      snapshotError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
  }
};

afterEach(async ({ task }) => {
  const testFailed = (task.result?.errors?.length ?? 0) > 0;
  for (const fixture of fixtures.splice(0)) {
    const preserveOnFailure = preservedTakeoverFailureFixtures.delete(fixture);
    let stopError: unknown;
    try {
      await fixture.stop();
    } catch (error) {
      stopError = error;
    }
    const diagnostic = takeoverFailureDiagnostic.get(fixture);
    takeoverFailureDiagnostic.delete(fixture);
    if (preserveOnFailure) {
      if (testFailed || stopError !== undefined) {
        const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
        if (resultDirectory === undefined) {
          throw new Error(
            `AH7 takeover failure evidence cannot be archived without ARBOR_TEST_RESULT_DIRECTORY; fixture=${fixture.directory}`,
            { cause: stopError },
          );
        }
        const repositoryRoot = resolve(process.cwd());
        const resultsRoot = resolve(repositoryRoot, ".test-results");
        const resolvedResultDirectory = resolve(resultDirectory);
        const resultsRootStat = lstatSync(resultsRoot);
        const resultDirectoryStat = lstatSync(resolvedResultDirectory);
        if (
          !resultsRootStat.isDirectory() ||
          resultsRootStat.isSymbolicLink() ||
          !resultDirectoryStat.isDirectory() ||
          resultDirectoryStat.isSymbolicLink()
        ) {
          throw new Error(
            `AH7 takeover archive destination contains a non-directory or reparse path: ${resolvedResultDirectory}`,
            { cause: stopError },
          );
        }
        const relativeResultsPath = relative(
          resultsRoot,
          resolvedResultDirectory,
        );
        if (
          relativeResultsPath === "" ||
          relativeResultsPath === ".." ||
          relativeResultsPath.startsWith(`..${sep}`) ||
          relativeResultsPath.startsWith(`${sep}`)
        ) {
          throw new Error(
            `AH7 takeover failure evidence directory is outside .test-results: ${resolvedResultDirectory}`,
            { cause: stopError },
          );
        }
        const resolvedFixtureDirectory = resolve(fixture.directory);
        const schemaRoot = dirname(resolvedFixtureDirectory);
        const schemaRootName = basename(schemaRoot);
        const relativeSchemaRoot = relative(repositoryRoot, schemaRoot);
        const schemaRootStat = lstatSync(schemaRoot);
        const fixtureStat = lstatSync(resolvedFixtureDirectory);
        if (
          relativeSchemaRoot !== schemaRootName ||
          !schemaRootName.startsWith(".arbor-functional-schema44-") ||
          !basename(resolvedFixtureDirectory).startsWith("fixture-") ||
          !schemaRootStat.isDirectory() ||
          schemaRootStat.isSymbolicLink() ||
          !fixtureStat.isDirectory() ||
          fixtureStat.isSymbolicLink()
        ) {
          throw new Error(
            `AH7 takeover fixture is outside the expected schema44 fixture root: ${fixture.directory}`,
            { cause: stopError },
          );
        }
        const archivedDirectory = join(
          resolvedResultDirectory,
          `ah7-reconcilable-takeover-${crypto.randomUUID()}`,
        );
        const archivedRelativePath = relative(
          resolvedResultDirectory,
          archivedDirectory,
        );
        if (
          archivedRelativePath !== basename(archivedDirectory) ||
          existsSync(archivedDirectory)
        ) {
          throw new Error(
            `AH7 takeover archive target is not a new direct result child: ${archivedDirectory}`,
            { cause: stopError },
          );
        }
        const captured = diagnostic?.() ?? null;
        renameSync(fixture.directory, archivedDirectory);
        const afterStop = {
          test: task.name,
          archivedDirectory,
          databaseFile: join(archivedDirectory, basename(fixture.databaseFile)),
          fixtureDirectory: join(archivedDirectory, "workspace"),
          primaryDaemon: fixture.daemonProcessSnapshot(),
          primaryDaemonStderr: fixture.daemonErrors,
          captured,
          cleanupError: stopError instanceof Error ? stopError.message : null,
        };
        writeFileSync(
          join(archivedDirectory, "ah7-after-stop-diagnostic.json"),
          `${JSON.stringify(afterStop, null, 2)}\n`,
          { flag: "wx" },
        );
        process.stdout.write(
          `[AH7_FAILURE_ARTIFACT] ${JSON.stringify({ test: task.name, archivedDirectory, databaseFile: afterStop.databaseFile, primaryDaemon: afterStop.primaryDaemon, primaryDaemonStderr: afterStop.primaryDaemonStderr, additionalDaemon: (afterStop.captured as { additionalDaemon?: unknown } | null)?.additionalDaemon })}\n`,
        );
      } else {
        removeFunctionalFixtureDirectory(fixture.directory);
      }
    }
    if (stopError !== undefined) throw stopError;
  }
});

describe("AH7 Reconcilable tool intent after process crash", () => {
  vi.setConfig({ testTimeout: 180_000 });
  type ReconciliationScenario = {
    readonly boundary: string;
    readonly semantics: "Reconcilable" | "NonIdempotent";
    readonly reconciliationMode?: "NotOccurred" | "Occurred" | "StillUnknown";
    readonly profileDrift?: "version" | "hash" | "effect-key";
    readonly resourceChangeDuringReconcile?: boolean;
    readonly reconciliationDrift?: "authority" | "approval" | "stop";
    readonly takeoverDuringReconciliationIo?: boolean;
    readonly proofMismatch?: "attemptNo" | "visibilityScopeSha256";
    readonly killDuringReconciliationIo?: boolean;
    readonly recoveryCrashBoundary?:
      | "AH7BeforeToolSettlementCommit"
      | "AH7AfterToolSettlementCommit"
      | "AH7BeforeActionResultCommit"
      | "AH7AfterActionResultCommit";
  };
  // Ordinary production composition registers shell@3 as NonIdempotent. The
  // test-only Reconcilable profile is available only in scenarios that inject
  // a reconciliationMode through reconciliationChild below.
  const scenarios: ReadonlyArray<ReconciliationScenario> = [
    {
      boundary: "AH7AfterToolIntentCommit",
      semantics: "NonIdempotent",
    },
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "NonIdempotent",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "NotOccurred",
      takeoverDuringReconciliationIo: true,
    },
    ...(["attemptNo", "visibilityScopeSha256"] as const).map(
      (proofMismatch) => ({
        boundary: "AH7AfterEffectAdmissionCommit" as const,
        semantics: "Reconcilable" as const,
        reconciliationMode: "NotOccurred" as const,
        takeoverDuringReconciliationIo: true,
        proofMismatch,
      }),
    ),
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "NotOccurred",
      killDuringReconciliationIo: true,
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "NotOccurred",
      resourceChangeDuringReconcile: true,
    },
    ...(["authority", "approval", "stop"] as const).map(
      (reconciliationDrift) => ({
        boundary: "AH7AfterEffectAdmissionCommit" as const,
        semantics: "Reconcilable" as const,
        reconciliationMode: "NotOccurred" as const,
        reconciliationDrift,
      }),
    ),
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "Reconcilable",
      reconciliationMode: "Occurred",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "StillUnknown",
    },
    ...(
      ["AH7BeforeActionResultCommit", "AH7AfterActionResultCommit"] as const
    ).map((recoveryCrashBoundary) => ({
      boundary: "AH7AfterEffectAdmissionCommit" as const,
      semantics: "Reconcilable" as const,
      reconciliationMode: "StillUnknown" as const,
      recoveryCrashBoundary,
    })),
    ...(["version", "hash", "effect-key"] as const).map((profileDrift) => ({
      boundary: "AH7AfterEffectAdmissionCommit" as const,
      semantics: "Reconcilable" as const,
      reconciliationMode: "NotOccurred" as const,
      profileDrift,
    })),
    ...(["NotOccurred", "Occurred"] as const).flatMap((reconciliationMode) =>
      (
        [
          "AH7BeforeToolSettlementCommit",
          "AH7AfterToolSettlementCommit",
        ] as const
      ).map((recoveryCrashBoundary) => ({
        boundary:
          reconciliationMode === "Occurred"
            ? ("AH7AfterToolEffectBeforeSettlement" as const)
            : ("AH7AfterEffectAdmissionCommit" as const),
        semantics: "Reconcilable" as const,
        reconciliationMode,
        recoveryCrashBoundary,
        resourceChangeDuringReconcile: true,
      })),
    ),
    ...(["NotOccurred", "Occurred"] as const).flatMap((reconciliationMode) =>
      (
        ["AH7BeforeActionResultCommit", "AH7AfterActionResultCommit"] as const
      ).map((recoveryCrashBoundary) => ({
        boundary:
          reconciliationMode === "Occurred"
            ? ("AH7AfterToolEffectBeforeSettlement" as const)
            : ("AH7AfterEffectAdmissionCommit" as const),
        semantics: "Reconcilable" as const,
        reconciliationMode,
        recoveryCrashBoundary,
      })),
    ),
  ];
  for (const scenario of scenarios) {
    const {
      boundary,
      semantics,
      reconciliationMode,
      profileDrift,
      resourceChangeDuringReconcile,
      reconciliationDrift,
      takeoverDuringReconciliationIo,
      proofMismatch,
      killDuringReconciliationIo,
      recoveryCrashBoundary,
    } = scenario;
    const mismatchedProofIsUnknown = proofMismatch !== undefined;
    const testName =
      profileDrift !== undefined
        ? `fails closed on trusted profile ${profileDrift} drift before source reconciliation`
        : reconciliationMode === "StillUnknown" &&
            recoveryCrashBoundary?.includes("ActionResult")
          ? `preserves the P9 escalation and resumes StillUnknown P3 projection across ${recoveryCrashBoundary}`
          : mismatchedProofIsUnknown
            ? `rejects G1 ${proofMismatch} proof after G0/G1 source-I/O takeover`
            : reconciliationMode !== undefined
              ? killDuringReconciliationIo
                ? "restarts after SIGKILL during reconciliation source lookup"
                : takeoverDuringReconciliationIo
                  ? "fences gen0 after delayed reconciliation I/O while gen1 retries the same invocation"
                  : resourceChangeDuringReconcile
                    ? recoveryCrashBoundary === undefined
                      ? "revalidates the Workspace resource snapshot after NotOccurred reconciliation I/O"
                      : `qualifies the P40 ${reconciliationMode} selection across ${recoveryCrashBoundary}`
                    : reconciliationDrift !== undefined
                      ? `rejects NotOccurred retry after ${reconciliationDrift} drift during reconciliation I/O`
                      : recoveryCrashBoundary === undefined
                        ? `recovers ${reconciliationMode} from a test-only trusted profile after a daemon restart`
                        : `recovers ${reconciliationMode} across ${recoveryCrashBoundary}`
              : boundary === "AH7AfterToolIntentCommit"
                ? "resumes a NotAdmitted shell intent from its persisted ProviderTurn"
                : `does not replay an ambiguous ${semantics} shell effect after ${boundary}`;
    const preserveTakeoverFixtureOnFailure =
      takeoverDuringReconciliationIo === true;
    const noEffectRetryDenied =
      reconciliationMode === "NotOccurred" &&
      (resourceChangeDuringReconcile || reconciliationDrift !== undefined);
    const resumesUnadmittedIntent = boundary === "AH7AfterToolIntentCommit";
    it(testName, async () => {
      const marker = `AH7-SHELL-${crypto.randomUUID().slice(0, 8)}`;
      const steerMarker = `AH7-SHELL-STEER-${crypto.randomUUID().slice(0, 8)}`;
      const effectFile = `ah7-effect-${marker}.txt`;
      const evidenceFile = `ah7-proof-${marker}.txt`;
      const resultFile = `ah7-result-${marker}.txt`;
      const command =
        process.platform === "win32"
          ? `Add-Content -LiteralPath '${effectFile}' -Value '${marker}'`
          : `printf '%s\\n' '${marker}' >> '${effectFile}'`;
      const hits: AhProbeHit[] = [];
      const runtimeProbeEvents: Array<Readonly<Record<string, unknown>>> = [];
      const processEvents: Array<Readonly<Record<string, unknown>>> = [];
      const additionalDaemonStdout: string[] = [];
      const providerReplyOperations: string[] = [];
      let targetProviderCalls = 0;
      let workProviderCalls = 0;
      let manualWaitCalls = 0;
      let preseedReadCalls = 0;
      let probeArmed = false;
      let latestToolResult = "<none>";
      const startupStdout: string[] = [];
      let releaseSteeredShellResponse!: () => void;
      let observeSteeredShellRequest!: () => void;
      let steeredShellResponseGated = false;
      let sandboxPolicyGrantExpiresAt = "";
      let failureIdentity:
        | {
            readonly projectId: string;
            readonly workspaceId: string;
            readonly executionId: string;
            readonly invocationId: string;
            readonly callRef: string;
          }
        | undefined;
      let oldLeaseGeneration: number | undefined;
      let newLeaseGeneration: number | undefined;
      let oldSourceReturnElapsedMs: number | null = null;
      let oldSourceReturnRows: Array<Readonly<Record<string, unknown>>> = [];
      let gen1DaemonForDiagnostic:
        | Awaited<ReturnType<ProductionFixture["startAdditionalDaemon"]>>
        | undefined;
      const steeredShellResponseGate = new Promise<void>((resolveGate) => {
        releaseSteeredShellResponse = resolveGate;
      });
      const steeredShellRequestObserved = new Promise<void>(
        (resolveObserved) => {
          observeSteeredShellRequest = resolveObserved;
        },
      );
      let fixture: ProductionFixture;
      const p11Fixture = createTrustedLocalP11FixtureEnvironment();
      const daemonEnvironment = p11Fixture.daemonEnvironment;
      Object.assign(daemonEnvironment, {
        ARBOR_AH_BOUNDARY:
          reconciliationMode === undefined ? boundary : "disabled",
        ...(semantics === "NonIdempotent"
          ? { ARBOR_AH_NON_IDEMPOTENT: "1" }
          : {}),
      });
      try {
        fixture = await startProductionFixture({
          admitWorkspaceDirectory: true,
          reply: (call) => {
            const names = new Set(
              call.tools.map((tool) => tool.function?.name),
            );
            const context = JSON.stringify(call.messages);
            if (
              names.has("assign_work") &&
              !names.has("claim_completion") &&
              context.includes(marker)
            ) {
              return context.includes("WorkAssigned(")
                ? { _tag: "Text", text: `Work admitted for ${marker}` }
                : {
                    _tag: "ToolCall",
                    name: "assign_work",
                    arguments: {
                      objective: `Wait for a human steer, then inspect the workspace with shell for ${marker}.`,
                      why: "qualify Reconcilable shell intent crash",
                      constraints: [],
                      completionExpectation:
                        "shell effect is not blindly replayed",
                      verificationMission: {
                        goal: `Verify safe shell recovery for ${marker}`,
                        criteria: [
                          {
                            criterionId: "shell-safe",
                            requirement:
                              "no ambiguous shell effect is replayed",
                            required: true,
                          },
                        ],
                        riskRequirements: [],
                      },
                      reason: "AH7 Reconcilable functional test",
                    },
                  };
            }
            if (
              names.has("claim_completion") &&
              names.has("shell") &&
              (context.includes(marker) ||
                (reconciliationMode !== undefined &&
                  context.includes(steerMarker)))
            ) {
              workProviderCalls += 1;
              if (!context.includes(steerMarker)) {
                if (reconciliationMode !== undefined && preseedReadCalls < 2) {
                  const path =
                    preseedReadCalls === 0 ? evidenceFile : resultFile;
                  preseedReadCalls += 1;
                  providerReplyOperations.push("read");
                  return {
                    _tag: "ToolCall",
                    name: "read",
                    arguments: {
                      target: { mount: "workspace", path },
                    },
                  };
                }
                manualWaitCalls += 1;
                providerReplyOperations.push("wait");
                return {
                  _tag: "ToolCall",
                  name: "wait",
                  arguments: {
                    reason: `waiting for ${steerMarker}`,
                    waitSpec: {
                      mode: "Any",
                      conditions: [{ _tag: "Manual" }],
                    },
                  },
                };
              }
              if (!probeArmed) {
                return {
                  _tag: "Text",
                  text: `Steer reached before the AH7 probe was armed: ${steerMarker}`,
                };
              }
              targetProviderCalls += 1;
              latestToolResult =
                [...call.messages]
                  .reverse()
                  .find((message) => message.role === "tool")?.content ??
                "<no tool result>";
              if (resourceChangeDuringReconcile && targetProviderCalls > 1) {
                return {
                  _tag: "Text",
                  text: `Resource snapshot changed during reconciliation for ${marker}`,
                };
              }
              if (targetProviderCalls > 5) {
                providerReplyOperations.push("http_error_429");
                return { _tag: "HttpError", status: 429 };
              }
              if (targetProviderCalls === 1) {
                providerReplyOperations.push("shell");
                return {
                  _tag: "ToolCall",
                  name: "shell",
                  arguments: {
                    command,
                    cwd: { mount: "workspace", path: "." },
                    timeoutMs: 5_000,
                  },
                };
              }
              providerReplyOperations.push("text");
              return { _tag: "Text", text: `Observed ${marker}` };
            }
            providerReplyOperations.push("text");
            return { _tag: "Text", text: `Waiting ${marker}` };
          },
          firstDaemonEntry: crashChild,
          daemonEnvironment,
          preserveDirectoryOnStop: preserveTakeoverFixtureOnFailure,
          setupProbe: p11Fixture.setupProbe,
          onDaemonStdout: (line) => {
            startupStdout.push(line);
            recordAhProbeLine(hits, line);
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              processEvents.push(event);
              if (event.runtimeProbe === true) runtimeProbeEvents.push(event);
            } catch {
              // Ignore non-JSON daemon output in this test-only trace.
            }
          },
          beforeResponse: async (call) => {
            const hasShell = call.tools.some(
              (tool) => tool.function?.name === "shell",
            );
            if (
              !steeredShellResponseGated &&
              hasShell &&
              JSON.stringify(call.messages).includes(steerMarker)
            ) {
              steeredShellResponseGated = true;
              observeSteeredShellRequest();
              await steeredShellResponseGate;
            }
            return "respond";
          },
        });
      } catch (error) {
        throw new Error(
          `AH7 daemon startup diagnostics: stdout=${startupStdout.join("\n") || "<empty>"}; cause=${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE === undefined)
        throw new Error(
          "AH7 P11 sandbox authority fixture was not initialized",
        );
      fixtures.push(fixture);
      if (preserveTakeoverFixtureOnFailure) {
        preservedTakeoverFailureFixtures.add(fixture);
        takeoverFailureDiagnostic.set(fixture, () => {
          const identity = failureIdentity;
          const gateFile = join(
            fixture.directory,
            "ah10-gates",
            "old-reconciliation-io.release",
          );
          const gateStat = existsSync(gateFile)
            ? statSync(gateFile)
            : undefined;
          const reconciliationRows =
            identity === undefined
              ? []
              : readTestReconciliationCalls(
                  fixture.databaseFile,
                  identity.invocationId,
                );
          return {
            testName,
            fixtureDirectory: fixture.directory,
            databaseFile: fixture.databaseFile,
            identity,
            generations: {
              old: oldLeaseGeneration,
              new: newLeaseGeneration,
            },
            oldSourceReturnElapsedMs,
            oldSourceReturnRows,
            primaryDaemon: fixture.daemonProcessSnapshot(),
            primaryDaemonStderr: fixture.daemonErrors,
            additionalDaemon:
              gen1DaemonForDiagnostic?.daemonProcessSnapshot() ?? null,
            additionalDaemonStderr: gen1DaemonForDiagnostic?.daemonErrors ?? [],
            releaseGate: {
              path: gateFile,
              exists: gateStat !== undefined,
              modifiedAt: gateStat?.mtime.toISOString() ?? null,
              size: gateStat?.size ?? null,
            },
            reconciliationSourceRows: {
              old: reconciliationRows.filter((row) => row.role === "old"),
              new: reconciliationRows.filter((row) => row.role === "new"),
            },
            reconciliationSourceReturns: readTestReconciliationSourceReturns(
              join(fixture.directory, "ah10-gates"),
              identity?.invocationId ?? "",
            ),
            daemonStdout: {
              primary: startupStdout.slice(-80),
              additional: additionalDaemonStdout.slice(-80),
            },
            provider: {
              requestCount: fixture.providerCalls.length,
              requests: fixture.providerCalls.map((call) => ({
                messageRoles: call.messages.map(
                  (message) => message.role ?? null,
                ),
                offeredTools: call.tools
                  .map((tool) => tool.function?.name)
                  .filter((name): name is string => name !== undefined),
              })),
              replyOperations: providerReplyOperations,
              counters: {
                targetProviderCalls,
                workProviderCalls,
                manualWaitCalls,
                preseedReadCalls,
              },
            },
            processEvents: processEvents.filter(
              (event) =>
                (identity !== undefined &&
                  (event.executionId === identity.executionId ||
                    event.invocationId === identity.invocationId)) ||
                event.boundary === "AH7ReconciliationSourceIO" ||
                event.boundary === "AH7ReconciliationResultFenceRejected",
            ),
            runtimeProbeEvents: runtimeProbeEvents.filter(
              (event) =>
                identity === undefined ||
                event.executionId === identity.executionId ||
                event.invocationId === identity.invocationId,
            ),
            consistentDatabaseSnapshot:
              identity === undefined
                ? null
                : readAh7FailureSnapshot(fixture.databaseFile, identity),
          };
        });
      }
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH7 shell intent ambiguity",
        { resourceSelection: "Profile" },
      );
      await initializeTrustedLocalP11Worktree({
        databaseFile: fixture.databaseFile,
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        path: fixture.workspaceDirectory,
      });
      if (reconciliationMode !== undefined) {
        writeFileSync(
          join(fixture.workspaceDirectory, evidenceFile),
          `${marker}-proof\n`,
        );
        writeFileSync(
          join(fixture.workspaceDirectory, resultFile),
          `${marker}-result\n`,
        );
      }
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "shell:exec",
        target: project.rootWorkspaceId,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
      await submitHumanMessage(
        client,
        project,
        `请创建一个等待人工指示后再用 shell 检查工作区的 Work，目标标记 ${marker}。`,
      );
      const approval = await waitForApproval(client, project, marker);
      expect(
        await client.view("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      ).toBeNull();
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH7 public Work admission",
      });
      const currentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value?.workId !== undefined &&
          value.objective?.includes(marker) === true,
      );
      if (currentWork?.workId === undefined) {
        throw new Error("AH7 public Reconcilable Work was not admitted");
      }
      const workId = currentWork.workId;
      expect(currentWork).toMatchObject({ revision: 0, status: "Open" });
      await waitForPublic(
        async () => ({ workProviderCalls, manualWaitCalls }),
        (value) => value.workProviderCalls >= 1 && value.manualWaitCalls >= 1,
      );
      const idleWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value?.workId === workId && value.activeExecution === undefined,
      );
      expect(idleWork).toMatchObject({ workId, revision: 0, status: "Open" });
      expect(targetProviderCalls).toBe(0);

      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry:
          reconciliationMode === undefined ? crashChild : reconciliationChild,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: boundary,
          ...(reconciliationMode === undefined
            ? {}
            : {
                ARBOR_AH10_ROLE: "old",
                ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
                ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
                ARBOR_AH7_TEST_CRASH_BOUNDARY: boundary,
                ...(resourceChangeDuringReconcile
                  ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
                  : {}),
                ...(reconciliationDrift === undefined
                  ? {}
                  : { ARBOR_AH7_TEST_DRIFT_ON_RECONCILE: reconciliationDrift }),
              }),
        },
      });
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: { severity: "Normal", guidance: steerMarker },
        provenance: { source: "HumanInput" },
      });
      const steeredWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) => value?.workId === workId && value.revision === 1,
      );
      expect(steeredWork?.status).toBe("Open");

      await steeredShellRequestObserved;
      const activeWorkForPolicy = await waitForPublic(
        () =>
          client.view<{
            readonly workId?: string;
            readonly revision: number;
            readonly activeExecution?: { readonly executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value?.workId === workId &&
          value.revision === 1 &&
          value.activeExecution?.executionId !== undefined,
      );
      const pregrantedExecutionId =
        activeWorkForPolicy?.activeExecution?.executionId;
      if (pregrantedExecutionId === undefined)
        throw new Error("AH7 current Work omitted the exact active Execution");
      sandboxPolicyGrantExpiresAt = new Date(
        Date.now() + 60 * 60_000,
      ).toISOString();
      await grantTrustedLocalP11Permission({
        client,
        projectId: project.projectId,
        executionId: pregrantedExecutionId,
        expiresAt: sandboxPolicyGrantExpiresAt,
      });
      releaseSteeredShellResponse();

      const commitCurrentP11Policy = async (executionId: string) => {
        const { snapshot } = await commitTrustedLocalP11Policy({
          client,
          baseUrl: fixture.baseUrl,
          databaseFile: fixture.databaseFile,
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          executionId,
          expiresAt: sandboxPolicyGrantExpiresAt,
        });
        expect(snapshot).toMatchObject({
          kind: "TrustedLocalUnconfinedV1",
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          executionId,
          profile: "FullAccess",
        });
      };

      const executableApproval = await waitForExactShellApproval({
        client,
        databaseFile: fixture.databaseFile,
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId,
        controlApprovalId: approval.approvalId,
        marker,
        command,
        sideEffectSemantics: semantics,
        ...(reconciliationMode === undefined ? {} : { timeoutMs: 12_000 }),
      });
      expect(executableApproval.row.execution_id).toBe(pregrantedExecutionId);
      expect(
        await client.command(project.projectId, "ResolveExecutableApproval", {
          approvalId: executableApproval.approvalId,
          expectedRevision: executableApproval.revision,
          decision: "Approve",
          reason: `AH7 public shell approval ${marker}`,
        }),
      ).toMatchObject({ body: { resolution: "Committed" } });

      let hit: AhProbeHit | undefined;
      let policyCommandDaemonStopped = false;
      if (resumesUnadmittedIntent) {
        hit = await waitForPublic(
          async () =>
            hits.find(
              (candidate) =>
                candidate.boundary === "AH7AfterToolIntentCommit" &&
                candidate.callRef === executableApproval.row.call_ref,
            ),
          (candidate) => candidate !== undefined,
          15_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH7 exact NotAdmitted P4 boundary absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
            { cause: error },
          );
        });
        if (hit?.executionId === undefined || hit.invocationId === undefined) {
          throw new Error("AH7 NotAdmitted boundary lacks exact invocation");
        }
        expect(hit.executionId).toBe(pregrantedExecutionId);
        await fixture.crash();
        expect(
          readP4InvocationApprovalBinding(
            fixture.databaseFile,
            hit.executionId,
            hit.invocationId,
          ),
        ).toMatchObject({
          effect_admission_state: "NotAdmitted",
          result_ref: null,
          settlement_kind: null,
        });

        // Command serving is deliberately decoupled from execution dispatch:
        // the startup tick parks the exact NotAdmitted intent on the missing
        // P11 policy, then the long interval prevents admission until the
        // public decision has committed.
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_TICK_INTERVAL_MS: "3600000",
          },
        });
        await commitCurrentP11Policy(hit.executionId);
        const parked = durableSnapshot(fixture.databaseFile);
        expect(
          readP4InvocationApprovalBinding(
            fixture.databaseFile,
            hit.executionId,
            hit.invocationId,
          ),
        ).toMatchObject({
          effect_admission_state: "NotAdmitted",
          result_ref: null,
          settlement_kind: null,
        });
        expect(
          parked.actions.filter(
            (action) =>
              action.execution_id === hit?.executionId &&
              action.call_ref === hit?.callRef,
          ),
        ).toEqual([
          expect.objectContaining({
            state: "Pending",
          }),
        ]);
        expect(
          parked.steps.filter(
            (step) =>
              step.execution_id === hit?.executionId &&
              step.logical_step_no === 0,
          ),
        ).toEqual([
          expect.objectContaining({
            state: "ActionsInProgress",
            next_action_index: 0,
          }),
        ]);
        expect(
          parked.toolResults.filter((row) =>
            isToolResultFor(row, hit?.invocationId ?? "", hit?.callRef ?? ""),
          ),
        ).toEqual([]);
        await fixture.crash();
        policyCommandDaemonStopped = true;
      } else {
        await commitCurrentP11Policy(pregrantedExecutionId);
        try {
          const observed = await waitForPublic(
            async () => ({ hits, targetProviderCalls }),
            (value) =>
              value.hits.some((candidate) => candidate.boundary === boundary) ||
              value.targetProviderCalls >= 5,
            30_000,
          );
          hit = observed.hits.find(
            (candidate) => candidate.boundary === boundary,
          );
          if (hit === undefined) {
            throw new Error(
              "provider-call cap reached before shell intent probe",
            );
          }
        } catch (error) {
          throw new Error(
            `AH7 shell intent probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        }
      }
      if (!policyCommandDaemonStopped) await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      if (
        hit?.executionId === undefined ||
        hit.invocationId === undefined ||
        hit.callRef === undefined
      ) {
        throw new Error("AH7 shell probe lacks exact execution/tool identity");
      }
      const targetExecutionId = hit.executionId;
      const targetCallRef = hit.callRef;
      const targetInvocationId = hit.invocationId;
      if (preserveTakeoverFixtureOnFailure) {
        failureIdentity = {
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          executionId: targetExecutionId,
          invocationId: targetInvocationId,
          callRef: targetCallRef,
        };
      }
      const bindingBeforeRecovery = readP39RecoveryBinding(
        fixture.databaseFile,
        targetInvocationId,
      );
      const attemptsBeforeRecovery = readEffectAttempts(
        fixture.databaseFile,
        targetInvocationId,
      );
      const crashedInvocationBinding = readP4InvocationApprovalBinding(
        fixture.databaseFile,
        targetExecutionId,
        hit.invocationId,
      );
      expect(crashedInvocationBinding).toMatchObject({
        invocation_id: hit.invocationId,
        execution_id: targetExecutionId,
        workspace_id: project.rootWorkspaceId,
        tool_name: "shell",
        tool_version: SHELL_DEFINITION.version,
        side_effect_semantics: semantics,
        approval_id: executableApproval.approvalId,
        effect_admission_state:
          boundary === "AH7AfterToolIntentCommit"
            ? "NotAdmitted"
            : "MayHaveStarted",
        result_ref: null,
      });
      expect(
        JSON.parse(crashedInvocationBinding?.arguments_json ?? "null"),
      ).toEqual(JSON.parse(executableApproval.row.arguments_json));
      const approvedResourceIds = JSON.parse(
        executableApproval.row.target_resource_space_ids_json,
      ) as ReadonlyArray<string>;
      const resolvedRegionIds = (
        JSON.parse(
          crashedInvocationBinding?.resolved_regions_json ?? "[]",
        ) as ReadonlyArray<{ readonly resourceSpaceId: string }>
      )
        .map((region) => region.resourceSpaceId)
        .sort();
      expect(resolvedRegionIds).toEqual([...approvedResourceIds].sort());
      const p39RecoveryBinding = readP39RecoveryBinding(
        fixture.databaseFile,
        hit.invocationId,
      );
      if (p39RecoveryBinding === undefined) {
        throw new Error("AH7 P39 recovery binding row absent after intent");
      }
      const canonicalRecoveryBinding = JSON.parse(
        p39RecoveryBinding.canonical_binding_json,
      ) as {
        readonly approvalId: string | null;
        readonly approvalSubject: string | null;
        readonly controlBasisDigest: string;
      };
      expect(canonicalRecoveryBinding).toMatchObject({
        approvalId: executableApproval.approvalId,
        approvalSubject: executableApproval.row.subject_ref,
        controlBasisDigest: executableApproval.row.control_basis_digest,
      });
      expect(canonicalRecoveryBinding.controlBasisDigest).toMatch(
        /^[0-9a-f]{64}$/u,
      );
      expect(p39RecoveryBinding.binding_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        createHash("sha256")
          .update(p39RecoveryBinding.canonical_binding_json)
          .digest("hex"),
      ).toBe(p39RecoveryBinding.binding_sha256);
      const approvalAtCrash = readExecutableApprovalAfterRecovery(
        fixture.databaseFile,
        executableApproval.approvalId,
        targetExecutionId,
      );
      expect(approvalAtCrash.approval).toMatchObject({
        approval_id: executableApproval.approvalId,
        route_kind: "Executable",
        execution_id: targetExecutionId,
        state: "Consumed",
        consumed_by: hit.invocationId,
        tool_invocation_id: hit.invocationId,
      });
      expect(approvalAtCrash.approvals).toEqual([
        expect.objectContaining({
          approval_id: executableApproval.approvalId,
          state: "Consumed",
          consumed_by: hit.invocationId,
        }),
      ]);
      const crashedActions = crashed.actions.filter(
        (action) => action.execution_id === targetExecutionId,
      );
      const crashedAction = crashedActions.find(
        (action) => action.call_ref === hit.callRef,
      );
      if (
        crashedAction?.logical_action_id === undefined ||
        crashedAction.call_ref === undefined
      ) {
        throw new Error("AH7 crash snapshot lacks exact action identity");
      }
      expect(crashedActions).toHaveLength(1);
      expect(crashedAction.call_ref).toBe(hit.callRef);
      const crashedTarget = readExecutionProviderTurns(
        fixture.databaseFile,
        targetExecutionId,
      );
      const crashedSourceStep = crashed.steps.find(
        (step) =>
          step.execution_id === targetExecutionId &&
          step.logical_step_no === crashedAction.logical_step_no &&
          step.repair_attempt === crashedAction.repair_attempt,
      );
      const originalProviderTurnId = crashedSourceStep?.provider_turn_id;
      if (originalProviderTurnId === undefined) {
        throw new Error("AH7 crash snapshot lacks the source ProviderTurn");
      }
      expect(crashedTarget.execution).toEqual({
        execution_id: targetExecutionId,
        episode_kind: "WorkEpisode",
        episode_ref: workId,
      });
      expect(
        crashed.toolInvocations.filter(
          (invocation) => invocation.execution_id === targetExecutionId,
        ),
      ).toEqual([
        expect.objectContaining({
          invocation_id: hit.invocationId,
          execution_id: targetExecutionId,
          side_effect_semantics: semantics,
          settled_at: null,
        }),
      ]);
      expect(crashedActions).toEqual([
        expect.objectContaining({
          execution_id: targetExecutionId,
          logical_action_id: crashedAction.logical_action_id,
          call_ref: crashedAction.call_ref,
          state: "Pending",
          action_kind: "shell",
        }),
      ]);
      const effectPath = join(fixture.workspaceDirectory, effectFile);
      expect(existsSync(effectPath)).toBe(
        boundary === "AH7AfterToolEffectBeforeSettlement",
      );
      const contentBefore = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      if (contentBefore !== null) {
        expect(contentBefore.trim()).toBe(marker);
      }

      if (semantics === "NonIdempotent") {
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_AH_NON_IDEMPOTENT: "1",
          },
        });
      } else if (profileDrift !== undefined) {
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE:
              reconciliationMode ?? "NotOccurred",
            ARBOR_AH7_TEST_PROFILE_DRIFT: profileDrift,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
          },
        });
        const drifted = await waitForPublic(
          async () => durableSnapshot(fixture.databaseFile),
          (value) =>
            value.actions.some(
              (action) =>
                action.execution_id === targetExecutionId &&
                action.call_ref === targetCallRef &&
                action.state === "ReconciliationPending",
            ) &&
            value.executions.some(
              (execution) =>
                execution.execution_id === targetExecutionId &&
                execution.settlement_kind === "OutcomeUnknown",
            ),
          45_000,
        );
        expect(
          readP4InvocationApprovalBinding(
            fixture.databaseFile,
            targetExecutionId,
            targetInvocationId,
          ),
        ).toMatchObject({
          effect_admission_state: "MayHaveStarted",
          result_ref: null,
          settlement_kind: null,
          settled_at: null,
          selected_attempt_no: null,
          selected_fact_id: null,
        });
        expect(
          drifted.actions.find((action) => action.call_ref === targetCallRef)
            ?.state,
        ).toBe("ReconciliationPending");
        expect(
          readReconciliationFacts(fixture.databaseFile, targetInvocationId),
        ).toEqual([]);
        expect(
          readEffectAttempts(fixture.databaseFile, targetInvocationId),
        ).toEqual(attemptsBeforeRecovery);
        expect(
          readP39RecoveryBinding(fixture.databaseFile, targetInvocationId),
        ).toEqual(bindingBeforeRecovery);
        expect(readTestExternalEffects(fixture.databaseFile)).toEqual([]);
        expect(
          readTestReconciliationCallCount(
            fixture.databaseFile,
            targetInvocationId,
          ),
        ).toBe(0);
        expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
          false,
        );
      } else if (
        reconciliationMode !== undefined &&
        noEffectRetryDenied &&
        !takeoverDuringReconciliationIo &&
        !recoveryCrashBoundary?.includes("ActionResult")
      ) {
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ...(resourceChangeDuringReconcile
              ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
              : {}),
            ...(reconciliationDrift === undefined
              ? {}
              : { ARBOR_AH7_TEST_DRIFT_ON_RECONCILE: reconciliationDrift }),
            ARBOR_AH7_TEST_CRASH_BOUNDARY: recoveryCrashBoundary ?? "disabled",
          },
        });
        if (recoveryCrashBoundary !== undefined) {
          await waitForPublic(
            async () => hits,
            (value) =>
              value.some(
                (candidate) =>
                  candidate.boundary === recoveryCrashBoundary &&
                  candidate.callRef === hit?.callRef,
              ),
            90_000,
          );
          const recoveryHit = hit;
          if (
            recoveryHit === undefined ||
            recoveryHit.invocationId === undefined ||
            recoveryHit.callRef === undefined
          ) {
            throw new Error("AH7 P40 boundary lacks the target invocation");
          }
          const recoveryCallRef = recoveryHit.callRef;
          const boundaryBinding = readP4InvocationApprovalBinding(
            fixture.databaseFile,
            targetExecutionId,
            recoveryHit.invocationId,
          );
          expect(
            readReconciliationFacts(
              fixture.databaseFile,
              recoveryHit.invocationId,
            ),
          ).toEqual([
            expect.objectContaining({
              outcome: "NotOccurred",
              fact_disposition: "RecoveryInput",
            }),
          ]);
          const shouldBeCommitted =
            recoveryCrashBoundary === "AH7AfterToolSettlementCommit";
          expect(boundaryBinding?.settlement_kind).toBe(
            shouldBeCommitted ? "ReconciledNoEffect" : null,
          );
          expect(boundaryBinding?.selected_fact_id).toEqual(
            shouldBeCommitted ? expect.any(String) : null,
          );
          expect(boundaryBinding?.observation_json === null).toBe(
            !shouldBeCommitted,
          );
          expect(
            durableSnapshot(fixture.databaseFile).toolResults.filter(
              (row) =>
                readToolResultForCall([row], recoveryCallRef) !== undefined,
            ),
          ).toHaveLength(0);
          await fixture.crash();
          await fixture.restart({
            entry: reconciliationChild,
            daemonEnvironment: {
              ARBOR_AH10_ROLE: "old",
              ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
              ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
              ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
              ...(resourceChangeDuringReconcile
                ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
                : {}),
              ...(reconciliationDrift === undefined
                ? {}
                : { ARBOR_AH7_TEST_DRIFT_ON_RECONCILE: reconciliationDrift }),
            },
          });
        }
      } else if (
        reconciliationMode === "NotOccurred" &&
        killDuringReconciliationIo
      ) {
        mkdirSync(join(fixture.directory, "ah10-gates"), { recursive: true });
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH10_PAUSE_LEASE_RENEWAL: "1",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
            ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO: "1",
            ARBOR_AH7_TEST_PAUSE_RECONCILIATION_IO: "1",
          },
        });
        const gen0SourceCall = await waitForPublic(
          async () =>
            processEvents.find(
              (event) =>
                event.boundary === "AH7ReconciliationSourceIO" &&
                event.role === "old" &&
                event.invocationId === hit?.invocationId,
            ),
          (event) => event !== undefined,
          30_000,
        );
        if (gen0SourceCall === undefined || hit?.invocationId === undefined) {
          throw new Error("AH7 old daemon did not pause inside source lookup");
        }
        const invocationId = hit.invocationId;
        const oldProcess = fixture.daemonProcessSnapshot();
        if (oldProcess?.pid === undefined || !oldProcess.alive) {
          throw new Error("AH7 old daemon PID is unavailable at source pause");
        }
        expect(oldProcess.alive).toBe(true);
        const sourcePauseDb = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        let oldLease:
          | {
              generation: number;
              worker_incarnation_id: string;
              expires_at: string;
            }
          | undefined;
        try {
          oldLease = sourcePauseDb
            .prepare(
              `SELECT generation, worker_incarnation_id, expires_at
                 FROM execution_leases WHERE execution_id = ?`,
            )
            .get(targetExecutionId) as typeof oldLease;
          expect(oldLease).toBeDefined();
          expect(
            readReconciliationFacts(fixture.databaseFile, invocationId),
          ).toEqual([]);
          expect(
            readP4InvocationApprovalBinding(
              fixture.databaseFile,
              targetExecutionId,
              invocationId,
            ),
          ).toMatchObject({
            selected_attempt_no: null,
            selected_fact_id: null,
            settlement_kind: null,
            settled_at: null,
          });
          expect(
            readEffectAttempts(fixture.databaseFile, invocationId),
          ).toEqual([
            expect.objectContaining({
              attempt_no: 0,
              admission_state: "MayHaveStarted",
            }),
          ]);
          const sourceCall = sourcePauseDb
            .prepare(
              `SELECT attempt_no, role, observed_effect
                 FROM ah7_test_reconciliation_calls WHERE invocation_id = ?`,
            )
            .get(invocationId);
          expect(sourceCall).toMatchObject({
            attempt_no: 0,
            role: "old",
            observed_effect: 0,
          });
          expect(
            findExactSourceReturn(
              join(fixture.directory, "ah10-gates"),
              invocationId,
              "old",
              0,
              0,
            ),
          ).toEqual([]);
        } finally {
          sourcePauseDb.close();
        }

        await fixture.crash();
        const killedProcess = fixture.daemonProcessSnapshot();
        expect(killedProcess).toMatchObject({
          pid: oldProcess.pid,
          alive: false,
        });
        if (process.platform !== "win32") {
          expect(killedProcess?.signalCode).toBe("SIGKILL");
        }
        expect(
          readReconciliationFacts(fixture.databaseFile, invocationId),
        ).toEqual([]);
        expect(
          readP4InvocationApprovalBinding(
            fixture.databaseFile,
            targetExecutionId,
            invocationId,
          ),
        ).toMatchObject({
          selected_attempt_no: null,
          selected_fact_id: null,
          settlement_kind: null,
          settled_at: null,
        });
        expect(readEffectAttempts(fixture.databaseFile, invocationId)).toEqual([
          expect.objectContaining({
            attempt_no: 0,
            admission_state: "MayHaveStarted",
          }),
        ]);

        const oldLeaseExpiry = Date.parse(oldLease?.expires_at ?? "");
        if (!Number.isFinite(oldLeaseExpiry)) {
          throw new Error("AH7 old source-lookup lease expiry is invalid");
        }
        await waitForPublic(
          async () => Date.now(),
          (now) => now >= oldLeaseExpiry,
          Math.max(30_000, oldLeaseExpiry - Date.now() + 10_000),
        );
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "new",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ...(proofMismatch === undefined
              ? {}
              : { ARBOR_AH7_TEST_PROOF_MISMATCH: proofMismatch }),
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
            ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO: "1",
          },
        });
        const gen1Lease = await waitForPublic(
          async () =>
            processEvents.find(
              (event) =>
                event.boundary === "AH10AfterLeaseAcquired" &&
                event.role === "new" &&
                event.executionId === targetExecutionId,
            ),
          (event) => event !== undefined,
          45_000,
        );
        expect(gen1Lease?.fencingGeneration).toBe(
          Number(oldLease?.generation) + 1,
        );
        const gen1SourceCall = await waitForPublic(
          async () =>
            processEvents.find(
              (event) =>
                event.boundary === "AH7ReconciliationSourceIO" &&
                event.role === "new" &&
                event.invocationId === invocationId,
            ),
          (event) => event !== undefined,
          30_000,
        );
        expect(gen1SourceCall).toMatchObject({
          attemptNo: 0,
          observedEffect: 0,
        });
        const recoveredAfterKill = await waitForPublic(
          async () => durableSnapshot(fixture.databaseFile),
          (value) =>
            value.toolInvocations.some(
              (invocation) =>
                invocation.invocation_id === invocationId &&
                invocation.settlement_kind === "Success",
            ) &&
            value.actions.some(
              (action) =>
                action.execution_id === targetExecutionId &&
                action.call_ref === hit?.callRef &&
                action.state === "Applied",
            ),
          45_000,
        );
        const recoveredBinding = readP4InvocationApprovalBinding(
          fixture.databaseFile,
          targetExecutionId,
          invocationId,
        );
        const recoveredFacts = readReconciliationFacts(
          fixture.databaseFile,
          invocationId,
        );
        const recoveredAttempts = readEffectAttempts(
          fixture.databaseFile,
          invocationId,
        );
        expect(recoveredFacts).toHaveLength(1);
        expect(recoveredFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "NotOccurred",
          fact_disposition: "RecoveryInput",
        });
        expect(recoveredBinding).toMatchObject({
          selected_attempt_no: null,
          selected_fact_id: null,
          settlement_kind: "Success",
          settlement_provenance: "Ordinary",
          observation_format_version: "p4-canonical-tool-observation-v1",
          observation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        expect(recoveredAttempts.map((attempt) => attempt.attempt_no)).toEqual([
          0, 1,
        ]);
        expect(recoveredAttempts[0]?.effect_key).toBe(
          recoveredAttempts[1]?.effect_key,
        );
        expect(recoveredAttempts[0]?.binding_sha256).toBe(
          recoveredAttempts[1]?.binding_sha256,
        );
        expect(recoveredAttempts[0]?.profile_id).toBe(
          recoveredAttempts[1]?.profile_id,
        );
        expect(recoveredAttempts[0]?.profile_version).toBe(
          recoveredAttempts[1]?.profile_version,
        );
        expect(recoveredAttempts[0]?.profile_hash).toBe(
          recoveredAttempts[1]?.profile_hash,
        );
        expect(readTestExternalEffects(fixture.databaseFile)).toEqual([
          expect.objectContaining({
            effect_key: `ah7-test:${invocationId}`,
          }),
        ]);
        expect(
          readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
            .split(/\r?\n/u)
            .filter((line) => line === marker),
        ).toHaveLength(1);
        expect(
          recoveredAfterKill.toolResults.filter(
            (row) =>
              readToolResultForCall([row], hit?.callRef ?? "") !== undefined,
          ),
        ).toHaveLength(1);
        expect(
          recoveredAfterKill.actions.filter(
            (action) =>
              action.execution_id === targetExecutionId &&
              action.call_ref === hit?.callRef,
          ),
        ).toHaveLength(1);
        await waitForReconciliationSourceReturn(
          join(fixture.directory, "ah10-gates"),
          fixture.databaseFile,
          invocationId,
          "new",
          0,
          0,
        );
        const callsAfterRestartDb = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        try {
          const calls = callsAfterRestartDb
            .prepare(
              `SELECT attempt_no, role, observed_effect
                 FROM ah7_test_reconciliation_calls WHERE invocation_id = ?
                ORDER BY call_no`,
            )
            .all(invocationId);
          expect(calls).toEqual([
            expect.objectContaining({
              attempt_no: 0,
              role: "old",
              observed_effect: 0,
            }),
            expect.objectContaining({
              attempt_no: 0,
              role: "new",
              observed_effect: 0,
            }),
          ]);
        } finally {
          callsAfterRestartDb.close();
        }
        expect(fixture.daemonProcessSnapshot()?.alive).toBe(true);
        expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldProcess.pid);
        expect(fixture.daemonErrors).toEqual([]);
      } else if (
        reconciliationMode !== undefined &&
        takeoverDuringReconciliationIo
      ) {
        mkdirSync(join(fixture.directory, "ah10-gates"), { recursive: true });
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH10_PAUSE_LEASE_RENEWAL: "1",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
            ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO: "1",
            ARBOR_AH7_TEST_PAUSE_RECONCILIATION_IO: "1",
          },
        });
        const gen0SourceCall = await waitForPublic(
          async () =>
            processEvents.find(
              (event) =>
                event.boundary === "AH7ReconciliationSourceIO" &&
                event.role === "old",
            ),
          (event) => event !== undefined,
          30_000,
        );
        if (gen0SourceCall === undefined) {
          throw new Error("AH7 gen0 source-I/O pause evidence is absent");
        }
        const leaseDb = new DatabaseSync(fixture.databaseFile);
        let gen0Lease:
          | {
              execution_id: string;
              worker_id: string;
              worker_incarnation_id: string;
              generation: number;
              expires_at: string;
            }
          | undefined;
        let gen0Generation: number;
        try {
          gen0Lease = leaseDb
            .prepare(
              `SELECT execution_id, worker_id, worker_incarnation_id, generation, expires_at
                 FROM execution_leases WHERE execution_id = ?`,
            )
            .get(targetExecutionId) as typeof gen0Lease;
          if (gen0Lease === undefined) {
            throw new Error("AH7 old owner lease row is absent");
          }
          gen0Generation = Number(gen0Lease.generation);
          oldLeaseGeneration = gen0Generation;
          const expiredAt = "1970-01-01T00:00:00.000Z";
          const update = leaseDb
            .prepare(
              `UPDATE execution_leases SET expires_at = ?
                WHERE execution_id = ? AND worker_id = ?
                  AND worker_incarnation_id = ? AND generation = ? AND expires_at = ?`,
            )
            .run(
              expiredAt,
              targetExecutionId,
              gen0Lease?.worker_id,
              gen0Lease?.worker_incarnation_id,
              gen0Lease?.generation,
              gen0Lease?.expires_at,
            );
          expect(Number(update.changes)).toBe(1);
        } finally {
          leaseDb.close();
        }
        const gen1Daemon = await fixture.startAdditionalDaemon({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "new",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ...(proofMismatch === undefined
              ? {}
              : { ARBOR_AH7_TEST_PROOF_MISMATCH: proofMismatch }),
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
            ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO: "1",
          },
          onStdout: (line) => {
            additionalDaemonStdout.push(line);
            recordAhProbeLine(hits, line);
            try {
              processEvents.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              // Ignore non-JSON daemon output in this test-only trace.
            }
          },
        });
        gen1DaemonForDiagnostic = gen1Daemon;
        const gen1Lease = await waitForPublic(
          async () =>
            processEvents.find(
              (event) =>
                event.boundary === "AH10AfterLeaseAcquired" &&
                event.role === "new" &&
                event.executionId === targetExecutionId,
            ),
          (event) => event !== undefined,
          45_000,
        );
        newLeaseGeneration = Number(gen1Lease?.fencingGeneration);
        expect(gen1Lease?.fencingGeneration).toBe(gen0Generation + 1);
        expect(gen1Daemon.daemonProcessSnapshot().pid).not.toBe(
          fixture.daemonProcessSnapshot()?.pid,
        );
        const gen1LeaseDb = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        try {
          const lease = gen1LeaseDb
            .prepare(
              `SELECT generation, worker_incarnation_id FROM execution_leases
                WHERE execution_id = ?`,
            )
            .get(targetExecutionId) as
            | { generation: number; worker_incarnation_id: string }
            | undefined;
          expect(lease).toMatchObject({
            generation: gen0Generation + 1,
          });
          expect(lease?.worker_incarnation_id).not.toBe(
            gen0Lease?.worker_incarnation_id,
          );
        } finally {
          gen1LeaseDb.close();
        }
        const gen1SourceCall = await waitForPublic(
          async () =>
            processEvents.find(
              (event) =>
                event.boundary === "AH7ReconciliationSourceIO" &&
                event.role === "new" &&
                event.invocationId === hit?.invocationId,
            ),
          (event) => event !== undefined,
          30_000,
        );
        expect(gen1SourceCall).toMatchObject({
          attemptNo: 0,
          observedEffect: 0,
        });
        if (mismatchedProofIsUnknown) {
          const p3CommittedByGen1 = await waitForPublic(
            async () => durableSnapshot(fixture.databaseFile),
            (value) =>
              value.actions.some(
                (action) =>
                  action.execution_id === targetExecutionId &&
                  action.call_ref === hit?.callRef &&
                  action.state === "ReconciliationPending",
              ),
            45_000,
          );
          const bindingBeforeStaleReturn = readP4InvocationApprovalBinding(
            fixture.databaseFile,
            targetExecutionId,
            targetInvocationId,
          );
          const factsBeforeStaleReturn = readReconciliationFacts(
            fixture.databaseFile,
            targetInvocationId,
          );
          const attemptsBeforeStaleReturn = readEffectAttempts(
            fixture.databaseFile,
            targetInvocationId,
          );
          expect(factsBeforeStaleReturn).toHaveLength(1);
          expect(factsBeforeStaleReturn[0]).toMatchObject({
            attempt_no: 0,
            outcome: "StillUnknown",
            reason_code: "EvidenceBindingMismatch",
            fact_disposition: "RecoveryInput",
            result_ref: null,
          });
          expect(attemptsBeforeStaleReturn).toEqual([
            expect.objectContaining({
              attempt_no: 0,
              admission_state: "MayHaveStarted",
            }),
          ]);
          expect(bindingBeforeStaleReturn).toMatchObject({
            effect_admission_state: "MayHaveStarted",
            settlement_kind: null,
            settled_at: null,
            selected_attempt_no: null,
            selected_fact_id: null,
            result_ref: null,
            observation_json: null,
          });
          const toolResultsAtP3Commit = p3CommittedByGen1.toolResults.filter(
            (row) => readToolResultForCall([row], hit?.callRef ?? ""),
          );
          expect(toolResultsAtP3Commit).toHaveLength(1);
          const targetToolResult = readToolResultForCall(
            p3CommittedByGen1.toolResults,
            hit?.callRef ?? "",
          );
          expect(targetToolResult?.payload).toMatchObject({
            status: "OutcomeUnknown",
            artifactRefs: [],
          });
          expect(targetToolResult?.payload).not.toHaveProperty("resultRef");
          expect(targetToolResult?.payload).not.toHaveProperty("canonicalRefs");
          const escalationRows = new DatabaseSync(fixture.databaseFile, {
            readOnly: true,
          });
          try {
            expect(
              escalationRows
                .prepare(
                  `SELECT COUNT(*) AS count FROM domain_events
                    WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?`,
                )
                .get(targetExecutionId),
            ).toMatchObject({ count: 1 });
          } finally {
            escalationRows.close();
          }
          const attention = await client.view<{
            rows: ReadonlyArray<{
              source?: string;
              severity?: string;
              dedupKey?: string;
            }>;
          }>("attention", { projectId: project.projectId });
          expect(
            attention.rows.filter(
              (row) =>
                row.source === "RecoveryEscalation" &&
                row.severity === "ActionRequired" &&
                row.dedupKey ===
                  `reconciliation-escalated:${targetExecutionId}:${targetInvocationId}`,
            ),
          ).toHaveLength(1);
          expect(
            p3CommittedByGen1.artifacts.filter(
              (artifact) => artifact.invocation_id === targetInvocationId,
            ),
          ).toEqual([]);
          expect(readTestExternalEffects(fixture.databaseFile)).toEqual([]);
          expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
            false,
          );
          const leaseBeforeStaleReturn = new DatabaseSync(
            fixture.databaseFile,
            { readOnly: true },
          );
          try {
            expect(
              leaseBeforeStaleReturn
                .prepare(
                  `SELECT generation, worker_incarnation_id FROM execution_leases
                    WHERE execution_id = ?`,
                )
                .get(targetExecutionId),
            ).toMatchObject({
              generation: gen0Generation + 1,
            });
          } finally {
            leaseBeforeStaleReturn.close();
          }
          const g1ActionResultCommit = await waitForPublic(
            async () =>
              processEvents.find(
                (event) =>
                  event.boundary === "AH7AfterActionResultCommit" &&
                  event.role === "new" &&
                  event.executionId === targetExecutionId &&
                  event.callRef === hit?.callRef,
              ),
            (event) => event !== undefined,
            20_000,
          );
          expect(g1ActionResultCommit).toMatchObject({
            boundary: "AH7AfterActionResultCommit",
            role: "new",
            executionId: targetExecutionId,
            callRef: hit?.callRef,
          });
          writeFileSync(
            join(fixture.directory, "ah10-gates", "new-action-result.release"),
            "allow G1 to return the settled P3 result",
          );
          const unresolvedByGen1 = await waitForPublic(
            async () => durableSnapshot(fixture.databaseFile),
            (value) =>
              value.actions.some(
                (action) =>
                  action.execution_id === targetExecutionId &&
                  action.call_ref === hit?.callRef &&
                  action.state === "ReconciliationPending",
              ) &&
              value.executions.some(
                (execution) =>
                  execution.execution_id === targetExecutionId &&
                  execution.settlement_kind === "OutcomeUnknown",
              ),
            45_000,
          );
          const executionBeforeStaleReturn = unresolvedByGen1.executions.find(
            (execution) => execution.execution_id === targetExecutionId,
          );
          expect(executionBeforeStaleReturn?.settlement_kind).toBe(
            "OutcomeUnknown",
          );
          const toolResultsBeforeStaleReturn =
            unresolvedByGen1.toolResults.filter((row) =>
              readToolResultForCall([row], hit?.callRef ?? ""),
            );
          expect(toolResultsBeforeStaleReturn).toHaveLength(1);
          expect(toolResultsBeforeStaleReturn).toEqual(toolResultsAtP3Commit);
          writeFileSync(
            join(
              fixture.directory,
              "ah10-gates",
              "old-reconciliation-io.release",
            ),
            "release stale gen0 source result",
          );
          let staleResultFence: Readonly<Record<string, unknown>> | undefined;
          let waitingFor: "old-source-returned" | "old-result-fence" =
            "old-source-returned";
          try {
            const oldSourceReturn = await waitForOldReconciliationCallReturn(
              join(fixture.directory, "ah10-gates"),
              fixture.databaseFile,
              targetInvocationId,
            );
            oldSourceReturnElapsedMs = oldSourceReturn.elapsedMs;
            oldSourceReturnRows = oldSourceReturn.records;
            waitingFor = "old-result-fence";
            staleResultFence = await waitForPublic(
              async () =>
                processEvents.find(
                  (event) =>
                    event.boundary === "AH7ReconciliationResultFenceRejected" &&
                    event.role === "old" &&
                    event.invocationId === targetInvocationId,
                ),
              (event) => event !== undefined,
              20_000,
            );
          } catch (error) {
            const diagnostic: Record<string, unknown> = {
              stage: waitingFor,
              fixtureDirectory: fixture.directory,
              databaseFile: fixture.databaseFile,
              identity: failureIdentity,
              oldGeneration: oldLeaseGeneration,
              newGeneration: newLeaseGeneration,
              gateFile: join(
                fixture.directory,
                "ah10-gates",
                "old-reconciliation-io.release",
              ),
              releaseGate: (() => {
                const gateFile = join(
                  fixture.directory,
                  "ah10-gates",
                  "old-reconciliation-io.release",
                );
                const gateStat = existsSync(gateFile)
                  ? statSync(gateFile)
                  : undefined;
                return {
                  path: gateFile,
                  exists: gateStat !== undefined,
                  modifiedAt: gateStat?.mtime.toISOString() ?? null,
                  size: gateStat?.size ?? null,
                };
              })(),
              reconciliationSourceRows: failureIdentity
                ? readTestReconciliationCalls(
                    fixture.databaseFile,
                    failureIdentity.invocationId,
                  )
                : [],
              reconciliationSourceReturns: failureIdentity
                ? readTestReconciliationSourceReturns(
                    join(fixture.directory, "ah10-gates"),
                    failureIdentity.invocationId,
                  )
                : [],
              state: takeoverFailureDiagnostic.get(fixture)?.() ?? null,
              failure: error instanceof Error ? error.message : String(error),
            };
            const diagnosticPath = join(
              fixture.directory,
              "ah7-g0-g1-fence-diagnostic.json",
            );
            try {
              writeFileSync(
                diagnosticPath,
                `${JSON.stringify(diagnostic, null, 2)}\n`,
                { flag: "wx" },
              );
            } catch (writeError) {
              diagnostic.snapshotWriteError =
                writeError instanceof Error
                  ? writeError.message
                  : String(writeError);
            }
            throw new Error(
              `AH7 G0/G1 ${proofMismatch ?? "NotOccurred"} takeover failed while waiting for ${waitingFor}; diagnosticFile=${diagnosticPath}; diagnostic=${JSON.stringify(diagnostic)}`,
              { cause: error },
            );
          }
          expect(staleResultFence).toMatchObject({
            boundary: "AH7ReconciliationResultFenceRejected",
            role: "old",
            invocationId: targetInvocationId,
            attemptNo: 0,
            outcomeTag: "NotOccurred",
          });
          const staleCallDb = new DatabaseSync(fixture.databaseFile, {
            readOnly: true,
          });
          try {
            expect(
              staleCallDb
                .prepare(
                  `SELECT attempt_no, role, observed_effect
                     FROM ah7_test_reconciliation_calls
                    WHERE invocation_id = ? AND role = 'old'`,
                )
                .get(targetInvocationId),
            ).toMatchObject({
              attempt_no: 0,
              role: "old",
              observed_effect: 0,
            });
          } finally {
            staleCallDb.close();
          }
          expect(
            readReconciliationFacts(fixture.databaseFile, targetInvocationId),
          ).toEqual(factsBeforeStaleReturn);
          expect(
            readEffectAttempts(fixture.databaseFile, targetInvocationId),
          ).toEqual(attemptsBeforeStaleReturn);
          expect(
            readP4InvocationApprovalBinding(
              fixture.databaseFile,
              targetExecutionId,
              targetInvocationId,
            ),
          ).toEqual(bindingBeforeStaleReturn);
          expect(readTestExternalEffects(fixture.databaseFile)).toEqual([]);
          const snapshotAfterStaleReturn = durableSnapshot(
            fixture.databaseFile,
          );
          expect(
            snapshotAfterStaleReturn.actions.filter(
              (action) => action.call_ref === hit?.callRef,
            ),
          ).toEqual([
            expect.objectContaining({
              state: "ReconciliationPending",
            }),
          ]);
          expect(
            snapshotAfterStaleReturn.executions.find(
              (execution) => execution.execution_id === targetExecutionId,
            ),
          ).toEqual(executionBeforeStaleReturn);
          expect(
            snapshotAfterStaleReturn.toolResults.filter((row) =>
              readToolResultForCall([row], hit?.callRef ?? ""),
            ),
          ).toEqual(toolResultsBeforeStaleReturn);
          const eventCountDb = new DatabaseSync(fixture.databaseFile, {
            readOnly: true,
          });
          try {
            expect(
              eventCountDb
                .prepare(
                  `SELECT COUNT(*) AS count FROM domain_events
                    WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?`,
                )
                .get(targetExecutionId),
            ).toMatchObject({ count: 1 });
          } finally {
            eventCountDb.close();
          }
          const attentionAfterStaleReturn = await client.view<{
            rows: ReadonlyArray<{
              source?: string;
              severity?: string;
              dedupKey?: string;
            }>;
          }>("attention", { projectId: project.projectId });
          expect(
            attentionAfterStaleReturn.rows.filter(
              (row) =>
                row.source === "RecoveryEscalation" &&
                row.severity === "ActionRequired" &&
                row.dedupKey ===
                  `reconciliation-escalated:${targetExecutionId}:${targetInvocationId}`,
            ),
          ).toHaveLength(1);
          expect(gen1Daemon.daemonProcessSnapshot().alive).toBe(true);
        } else {
          const recoveredByGen1 = await waitForPublic(
            async () => durableSnapshot(fixture.databaseFile),
            (value) =>
              value.toolInvocations.some(
                (invocation) =>
                  invocation.invocation_id === hit?.invocationId &&
                  invocation.settlement_kind === "Success",
              ) &&
              value.actions.some(
                (action) =>
                  action.execution_id === targetExecutionId &&
                  action.call_ref === hit?.callRef &&
                  action.state === "Applied",
              ),
            45_000,
          );
          expect(gen1Daemon.daemonProcessSnapshot().alive).toBe(true);
          expect(recoveredByGen1.toolInvocations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                invocation_id: hit?.invocationId,
                settlement_kind: "Success",
              }),
            ]),
          );
          const factsBeforeGen0Return = readReconciliationFacts(
            fixture.databaseFile,
            targetInvocationId,
          );
          expect(factsBeforeGen0Return).toHaveLength(1);
          expect(factsBeforeGen0Return[0]).toMatchObject({
            attempt_no: 0,
            outcome: "NotOccurred",
            fact_disposition: "RecoveryInput",
          });
          const attemptsBeforeGen0Return = (() => {
            const db = new DatabaseSync(fixture.databaseFile, {
              readOnly: true,
            });
            try {
              return db
                .prepare(
                  `SELECT attempt_no, admission_state
                   FROM tool_invocation_effect_attempts
                  WHERE invocation_id = ? ORDER BY attempt_no`,
                )
                .all(targetInvocationId);
            } finally {
              db.close();
            }
          })();
          expect(attemptsBeforeGen0Return).toHaveLength(2);
          writeFileSync(
            join(
              fixture.directory,
              "ah10-gates",
              "old-reconciliation-io.release",
            ),
            "release stale gen0 source result",
          );
          const oldSourceReturn = await waitForOldReconciliationCallReturn(
            join(fixture.directory, "ah10-gates"),
            fixture.databaseFile,
            targetInvocationId,
          );
          oldSourceReturnElapsedMs = oldSourceReturn.elapsedMs;
          oldSourceReturnRows = oldSourceReturn.records;
          const takeoverDb = new DatabaseSync(fixture.databaseFile, {
            readOnly: true,
          });
          try {
            const calls = takeoverDb
              .prepare(
                `SELECT call_no, invocation_id, attempt_no, role, observed_effect
                 FROM ah7_test_reconciliation_calls WHERE invocation_id = ?
                 ORDER BY call_no`,
              )
              .all(hit?.invocationId) as Array<Record<string, unknown>>;
            expect(calls).toEqual([
              expect.objectContaining({
                attempt_no: 0,
                role: "old",
                observed_effect: 0,
              }),
              expect.objectContaining({
                attempt_no: 0,
                role: "new",
                observed_effect: 0,
              }),
            ]);
            expect(
              readReconciliationFacts(fixture.databaseFile, hit.invocationId),
            ).toEqual(factsBeforeGen0Return);
            const externalEffects = takeoverDb
              .prepare(
                "SELECT effect_key FROM ah7_test_external_effects WHERE effect_key = ?",
              )
              .all(`ah7-test:${hit.invocationId}`);
            expect(externalEffects).toHaveLength(1);
            const attempts = takeoverDb
              .prepare(
                `SELECT attempt_no, admission_state
                 FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? ORDER BY attempt_no`,
              )
              .all(hit.invocationId) as Array<Record<string, unknown>>;
            expect(attempts).toHaveLength(2);
            expect(attempts).toEqual(attemptsBeforeGen0Return);
            expect(attempts.map((attempt) => attempt.attempt_no)).toEqual([
              0, 1,
            ]);
            expect(attempts.map((attempt) => attempt.admission_state)).toEqual([
              "MayHaveStarted",
              "MayHaveStarted",
            ]);
          } finally {
            takeoverDb.close();
          }
        }
        await gen1Daemon.crash();
      } else if (reconciliationMode !== undefined) {
        const factBoundary =
          String(reconciliationMode) === "NotOccurred"
            ? "AH7BeforeReconciliationFactCommit"
            : "AH7AfterReconciliationFactCommit";
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
            ARBOR_AH7_TEST_RECONCILIATION_FACT_BOUNDARY: factBoundary,
          },
        });
        await waitForPublic(
          async () => hits,
          (value) =>
            value.some((candidate) => candidate.boundary === factBoundary),
          30_000,
        );
        const factsAtFactBoundary = readReconciliationFacts(
          fixture.databaseFile,
          hit.invocationId,
        );
        expect(factsAtFactBoundary).toHaveLength(
          factBoundary === "AH7BeforeReconciliationFactCommit" ? 0 : 1,
        );
        if (factBoundary === "AH7AfterReconciliationFactCommit") {
          expect(factsAtFactBoundary[0]).toMatchObject({
            outcome: reconciliationMode,
            fact_disposition: "RecoveryInput",
          });
        }
        await fixture.crash();
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: recoveryCrashBoundary ?? "disabled",
            ...(resourceChangeDuringReconcile
              ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
              : {}),
          },
        });
        if (recoveryCrashBoundary !== undefined) {
          await waitForPublic(
            async () => hits,
            (value) =>
              value.some(
                (candidate) =>
                  candidate.boundary === recoveryCrashBoundary &&
                  candidate.callRef === hit?.callRef,
              ),
            recoveryCrashBoundary.includes("ToolSettlement") ? 90_000 : 45_000,
          );
          const recoveryHit = hit;
          if (
            recoveryHit === undefined ||
            recoveryHit.invocationId === undefined ||
            recoveryHit.callRef === undefined
          ) {
            throw new Error(
              "AH7 recovery boundary lacks the target invocation",
            );
          }
          const recoveryCallRef = recoveryHit.callRef;
          const boundarySnapshot = durableSnapshot(fixture.databaseFile);
          const boundaryBinding = readP4InvocationApprovalBinding(
            fixture.databaseFile,
            targetExecutionId,
            recoveryHit.invocationId,
          );
          if (recoveryCrashBoundary.includes("ActionResult")) {
            expect(boundaryBinding?.settlement_kind).toBe(
              reconciliationMode === "StillUnknown" ? null : "Success",
            );
            const projectedAction = boundarySnapshot.actions.filter(
              (action) => action.call_ref === recoveryCallRef,
            );
            const projectedResults = boundarySnapshot.toolResults.filter(
              (row) =>
                readToolResultForCall([row], recoveryCallRef) !== undefined,
            );
            if (reconciliationMode === "StillUnknown") {
              const boundaryFacts = readReconciliationFacts(
                fixture.databaseFile,
                recoveryHit.invocationId,
              );
              expect(boundaryFacts).toHaveLength(1);
              expect(boundaryFacts[0]).toMatchObject({
                outcome: "StillUnknown",
                fact_disposition: "RecoveryInput",
              });
              expect(boundarySnapshot.executions).toContainEqual(
                expect.objectContaining({
                  execution_id: targetExecutionId,
                  settlement_kind: null,
                }),
              );
              const eventDb = new DatabaseSync(fixture.databaseFile, {
                readOnly: true,
              });
              let escalationAtBoundary: ReadonlyArray<{
                payload_json: string;
              }>;
              try {
                escalationAtBoundary = eventDb
                  .prepare(
                    "SELECT payload_json FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
                  )
                  .all(
                    targetExecutionId,
                  ) as unknown as typeof escalationAtBoundary;
              } finally {
                eventDb.close();
              }
              expect(escalationAtBoundary).toHaveLength(1);
              expect(
                JSON.parse(String(escalationAtBoundary[0]?.payload_json)),
              ).toEqual({
                executionId: targetExecutionId,
                invocationRefsFingerprint: recoveryHit.invocationId,
                refs: [recoveryHit.invocationId],
              });
              const attentionAtBoundary = await client.view<{
                rows: ReadonlyArray<{
                  source?: string;
                  severity?: string;
                  targetWorkspaceId?: string;
                  dedupKey?: string;
                }>;
              }>("attention", { projectId: project.projectId });
              const unresolvedRows = attentionAtBoundary.rows.filter(
                (row) =>
                  row.source === "RecoveryEscalation" &&
                  row.dedupKey ===
                    `reconciliation-escalated:${targetExecutionId}:${recoveryHit.invocationId}`,
              );
              expect(unresolvedRows).toHaveLength(1);
              expect(unresolvedRows[0]).toMatchObject({
                severity: "ActionRequired",
                targetWorkspaceId: project.rootWorkspaceId,
              });
            }
            if (recoveryCrashBoundary === "AH7BeforeActionResultCommit") {
              expect(projectedAction).toHaveLength(1);
              expect(projectedAction[0]?.state).toBe("Pending");
              expect(projectedResults).toHaveLength(0);
            } else {
              expect(projectedAction).toHaveLength(1);
              expect(projectedAction[0]?.state).toBe(
                reconciliationMode === "StillUnknown"
                  ? "ReconciliationPending"
                  : "Applied",
              );
              expect(projectedResults).toHaveLength(1);
            }
          } else {
            const shouldBeCommitted =
              recoveryCrashBoundary === "AH7AfterToolSettlementCommit";
            expect(boundaryBinding?.settlement_kind).toBe(
              shouldBeCommitted
                ? reconciliationMode === "Occurred"
                  ? "Success"
                  : "ReconciledNoEffect"
                : null,
            );
            expect(boundaryBinding?.selected_fact_id).toEqual(
              shouldBeCommitted ? expect.any(String) : null,
            );
            if (reconciliationMode === "Occurred" && shouldBeCommitted) {
              const selectedFact = readReconciliationFacts(
                fixture.databaseFile,
                recoveryHit.invocationId,
              )[0];
              expect(boundaryBinding).toMatchObject({
                settlement_provenance: "Reconciliation",
                selected_attempt_no: 0,
                result_ref: expect.stringMatching(/^art_/u),
              });
              expect(boundaryBinding?.selected_fact_id).toBe(
                selectedFact?.fact_id,
              );
              expect(boundaryBinding?.result_ref).toBe(
                selectedFact?.result_ref,
              );
              const boundaryEffects = readTestExternalEffects(
                fixture.databaseFile,
              );
              expect(boundaryEffects).toHaveLength(1);
              expect(boundaryEffects[0]?.result_ref).toBe(
                selectedFact?.result_ref,
              );
            }
            expect(boundaryBinding?.observation_json === null).toBe(
              !shouldBeCommitted,
            );
            expect(
              boundarySnapshot.toolResults.filter(
                (row) =>
                  readToolResultForCall([row], recoveryCallRef) !== undefined,
              ),
            ).toHaveLength(0);
          }
          await fixture.crash();
          await fixture.restart({
            entry: reconciliationChild,
            daemonEnvironment: {
              ARBOR_AH10_ROLE: "old",
              ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
              ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
              ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
              ...(resourceChangeDuringReconcile
                ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
                : {}),
            },
          });
        }
      } else {
        await fixture.restart();
      }
      let recovered: ReturnType<typeof durableSnapshot>;
      try {
        if (noEffectRetryDenied) {
          await waitForPublic(
            async () =>
              readP4InvocationApprovalBinding(
                fixture.databaseFile,
                targetExecutionId,
                targetInvocationId,
              ),
            (value) => value?.settlement_kind === "ReconciledNoEffect",
            reconciliationDrift === undefined ? 45_000 : 90_000,
          );
          recovered = durableSnapshot(fixture.databaseFile);
        } else {
          recovered = await waitForPublic(
            async () => durableSnapshot(fixture.databaseFile),
            (value) => {
              if (resumesUnadmittedIntent) {
                const successorStep = value.steps.find(
                  (step) =>
                    step.execution_id === targetExecutionId &&
                    step.logical_step_no ===
                      Number(crashedSourceStep?.logical_step_no ?? -1) + 1,
                );
                return (
                  value.actions.some(
                    (action) =>
                      action.execution_id === targetExecutionId &&
                      action.call_ref === hit?.callRef &&
                      action.state ===
                        (resourceChangeDuringReconcile
                          ? "TerminalRejected"
                          : "Applied"),
                  ) &&
                  value.toolInvocations.some(
                    (invocation) =>
                      invocation.invocation_id === hit?.invocationId &&
                      invocation.execution_id === targetExecutionId &&
                      invocation.settlement_kind === "Success",
                  ) &&
                  value.toolResults.some((row) =>
                    isToolResultFor(
                      row,
                      hit?.invocationId ?? "",
                      hit?.callRef ?? "",
                    ),
                  ) &&
                  successorStep !== undefined &&
                  successorStep.provider_turn_id !== originalProviderTurnId &&
                  value.providerTurns.some(
                    (turn) =>
                      turn.provider_turn_id ===
                        successorStep.provider_turn_id &&
                      turn.settled_at !== null,
                  ) &&
                  value.outputs.filter(
                    (output) =>
                      output.source_ref ===
                      `${successorStep.provider_turn_id}:assistant`,
                  ).length === 1
                );
              }
              if (profileDrift !== undefined) {
                return (
                  value.actions.some(
                    (action) =>
                      action.execution_id === targetExecutionId &&
                      action.call_ref === hit?.callRef &&
                      action.state === "ReconciliationPending",
                  ) &&
                  value.executions.some(
                    (execution) =>
                      execution.execution_id === targetExecutionId &&
                      execution.settlement_kind === "OutcomeUnknown",
                  )
                );
              }
              if (mismatchedProofIsUnknown) {
                return value.actions.some(
                  (action) =>
                    action.execution_id === targetExecutionId &&
                    action.call_ref === hit?.callRef &&
                    action.state === "ReconciliationPending",
                );
              }
              if (
                reconciliationMode === "NotOccurred" ||
                reconciliationMode === "Occurred"
              ) {
                if (noEffectRetryDenied) {
                  return value.toolInvocations.some(
                    (invocation) =>
                      invocation.invocation_id === hit?.invocationId &&
                      invocation.settlement_kind === "ReconciledNoEffect",
                  );
                }
                return (
                  value.actions.some(
                    (action) =>
                      action.execution_id === targetExecutionId &&
                      action.call_ref === hit?.callRef &&
                      action.state === "Applied",
                  ) &&
                  value.toolInvocations.some(
                    (invocation) =>
                      invocation.invocation_id === hit?.invocationId &&
                      invocation.settlement_kind ===
                        (noEffectRetryDenied
                          ? "ReconciledNoEffect"
                          : "Success"),
                  ) &&
                  value.toolResults.some((row) =>
                    isToolResultFor(
                      row,
                      hit?.invocationId ?? "",
                      hit?.callRef ?? "",
                    ),
                  )
                );
              }
              return (
                value.actions.some(
                  (action) =>
                    action.execution_id === targetExecutionId &&
                    action.call_ref === hit?.callRef &&
                    action.state === "ReconciliationPending",
                ) &&
                value.executions.some(
                  (execution) =>
                    execution.execution_id === targetExecutionId &&
                    execution.settlement_kind === "OutcomeUnknown",
                )
              );
            },
            45_000,
          );
        }
      } catch (error) {
        if (!noEffectRetryDenied) throw error;
        throw new Error(
          `NotOccurred retry-denial recovery did not settle: ${error instanceof Error ? error.message : String(error)}; invocation=${JSON.stringify(readP4InvocationApprovalBinding(fixture.databaseFile, targetExecutionId, hit.invocationId))}; facts=${JSON.stringify(readReconciliationFacts(fixture.databaseFile, hit.invocationId))}; runtimeProbes=${JSON.stringify(runtimeProbeEvents.filter((event) => event.invocationId === hit.invocationId).map((event) => ({ boundary: event.boundary, outcomeTag: event.outcomeTag, admissionResult: event.admissionResult })))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      const recoveredTarget = readExecutionProviderTurns(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(recoveredTarget.execution).toEqual(crashedTarget.execution);
      const recoveredTargetInvocations = recovered.toolInvocations.filter(
        (invocation) => invocation.execution_id === targetExecutionId,
      );
      expect(recoveredTargetInvocations).toHaveLength(1);
      const settledInvocation = recoveredTargetInvocations[0];
      expect(settledInvocation).toMatchObject({
        invocation_id: hit.invocationId,
        execution_id: targetExecutionId,
        side_effect_semantics: semantics,
      });
      const recoveredInvocationBinding = readP4InvocationApprovalBinding(
        fixture.databaseFile,
        targetExecutionId,
        hit.invocationId,
      );
      expect(recoveredInvocationBinding?.approval_id).toBe(
        executableApproval.approvalId,
      );
      expect(recoveredInvocationBinding?.arguments_json).toBe(
        executableApproval.row.arguments_json,
      );
      const reconciliationFacts =
        reconciliationMode === undefined
          ? []
          : readReconciliationFacts(fixture.databaseFile, hit.invocationId);
      const effectAttempts =
        reconciliationMode === undefined
          ? []
          : readEffectAttempts(fixture.databaseFile, hit.invocationId);
      const externalEffects =
        reconciliationMode === undefined
          ? []
          : readTestExternalEffects(fixture.databaseFile);
      if (profileDrift !== undefined) {
        expect(reconciliationFacts).toEqual([]);
        expect(effectAttempts).toEqual(attemptsBeforeRecovery);
        expect(effectAttempts).toHaveLength(1);
        expect(effectAttempts[0]).toMatchObject({
          attempt_no: 0,
          admission_state: "MayHaveStarted",
        });
        expect(
          readP39RecoveryBinding(fixture.databaseFile, hit.invocationId),
        ).toEqual(bindingBeforeRecovery);
        expect(externalEffects).toEqual([]);
        expect(
          readTestReconciliationCallCount(
            fixture.databaseFile,
            hit.invocationId,
          ),
        ).toBe(0);
        expect(recoveredInvocationBinding).toMatchObject({
          effect_admission_state: "MayHaveStarted",
          result_ref: null,
          settlement_kind: null,
          settled_at: null,
          selected_attempt_no: null,
          selected_fact_id: null,
        });
      } else if (mismatchedProofIsUnknown) {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "StillUnknown",
          reason_code: "EvidenceBindingMismatch",
          fact_disposition: "RecoveryInput",
          result_ref: null,
        });
        expect(effectAttempts).toEqual([
          expect.objectContaining({
            attempt_no: 0,
            admission_state: "MayHaveStarted",
          }),
        ]);
        expect(externalEffects).toEqual([]);
        expect(recoveredInvocationBinding).toMatchObject({
          settlement_kind: null,
          settled_at: null,
          selected_attempt_no: null,
          selected_fact_id: null,
          result_ref: null,
          observation_json: null,
        });
      } else if (reconciliationMode === "NotOccurred") {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "NotOccurred",
          reason_code: null,
          fact_disposition: "RecoveryInput",
          result_ref: null,
        });
        expect(reconciliationFacts[0]?.evidence_ref).toMatch(/^art_/u);
        if (noEffectRetryDenied) {
          expect(effectAttempts).toHaveLength(1);
          expect(effectAttempts[0]).toMatchObject({
            attempt_no: 0,
            admission_state: "MayHaveStarted",
          });
          expect(externalEffects).toHaveLength(0);
          expect(recoveredInvocationBinding).toMatchObject({
            settlement_kind: "ReconciledNoEffect",
            settlement_provenance: "Reconciliation",
            selected_attempt_no: 0,
            selected_fact_id: reconciliationFacts[0]?.fact_id,
            observation_format_version: "p4-canonical-tool-observation-v1",
          });
          expect(recoveredInvocationBinding?.result_ref).toMatch(/^art_/u);
          const expectedReasonCode =
            reconciliationDrift === "authority"
              ? "AuthoritySnapshotChanged"
              : reconciliationDrift === "approval"
                ? "ApprovalNoLongerAuthorized"
                : reconciliationDrift === "stop"
                  ? "StopRequested"
                  : "ResourceSnapshotChanged";
          expect(
            JSON.parse(String(recoveredInvocationBinding?.settlement_json)),
          ).toMatchObject({
            _tag: "ReconciledNoEffect",
            reasonCode: expectedReasonCode,
          });
          const observation = JSON.parse(
            Buffer.from(
              recoveredInvocationBinding?.observation_json ?? new Uint8Array(),
            ).toString("utf8"),
          );
          expect(observation).toMatchObject({
            _tag: "ReconciledNoEffect",
            reasonCode: expectedReasonCode,
            reconciliationFactRef: reconciliationFacts[0]?.fact_id,
          });
        } else {
          expect(effectAttempts).toHaveLength(2);
          expect(effectAttempts.map((attempt) => attempt.attempt_no)).toEqual([
            0, 1,
          ]);
          expect(
            effectAttempts.map((attempt) => attempt.admission_state),
          ).toEqual(["MayHaveStarted", "MayHaveStarted"]);
          expect(effectAttempts[0]?.effect_key).toBe(
            effectAttempts[1]?.effect_key,
          );
          expect(externalEffects).toHaveLength(1);
          expect(externalEffects[0]?.result_ref).toMatch(/^art_/u);
          expect(recoveredInvocationBinding).toMatchObject({
            settlement_kind: "Success",
            settlement_provenance: "Ordinary",
            selected_attempt_no: null,
            selected_fact_id: null,
            observation_format_version: "p4-canonical-tool-observation-v1",
          });
        }
        expect(recoveredInvocationBinding?.observation_sha256).toMatch(
          /^[0-9a-f]{64}$/u,
        );
        expect(recoveredInvocationBinding?.observation_json).not.toBeNull();
      } else if (reconciliationMode === "Occurred") {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "Occurred",
          reason_code: null,
          fact_disposition: "RecoveryInput",
        });
        expect(reconciliationFacts[0]?.evidence_ref).toMatch(/^art_/u);
        expect(reconciliationFacts[0]?.result_ref).toMatch(/^art_/u);
        expect(reconciliationFacts[0]?.result_ref).not.toBe(
          reconciliationFacts[0]?.evidence_ref,
        );
        expect(effectAttempts).toHaveLength(1);
        expect(externalEffects).toHaveLength(1);
        expect(recoveredInvocationBinding).toMatchObject({
          settlement_kind: "Success",
          settlement_provenance: "Reconciliation",
          selected_attempt_no: 0,
          selected_fact_id: reconciliationFacts[0]?.fact_id,
          result_ref: reconciliationFacts[0]?.result_ref,
          observation_format_version: "p4-canonical-tool-observation-v1",
        });
        expect(recoveredInvocationBinding?.observation_sha256).toMatch(
          /^[0-9a-f]{64}$/u,
        );
        expect(recoveredInvocationBinding?.observation_json).not.toBeNull();
      } else if (reconciliationMode === "StillUnknown") {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "StillUnknown",
          reason_code: "AttemptNotFinal",
          fact_disposition: "RecoveryInput",
          result_ref: null,
          evidence_ref: null,
        });
        expect(effectAttempts).toHaveLength(1);
        expect(externalEffects).toHaveLength(0);
        expect(recoveredInvocationBinding).toMatchObject({
          settlement_kind: null,
          settled_at: null,
          result_ref: null,
          observation_format_version: null,
          observation_json: null,
          observation_sha256: null,
        });
        const escalationDb = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        let escalationRows: ReadonlyArray<{
          event_type: string;
          payload_json: string;
        }>;
        try {
          escalationRows = escalationDb
            .prepare(
              "SELECT event_type, payload_json FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
            )
            .all(targetExecutionId) as unknown as typeof escalationRows;
        } finally {
          escalationDb.close();
        }
        expect(escalationRows).toHaveLength(1);
        expect(JSON.parse(String(escalationRows[0]?.payload_json))).toEqual({
          executionId: targetExecutionId,
          invocationRefsFingerprint: hit.invocationId,
          refs: [hit.invocationId],
        });
        const attention = await client.view<{
          rows: ReadonlyArray<{
            source?: string;
            severity?: string;
            targetWorkspaceId?: string;
            dedupKey?: string;
          }>;
        }>("attention", { projectId: project.projectId });
        const visibleEscalations = attention.rows.filter(
          (row) =>
            row.source === "RecoveryEscalation" &&
            row.dedupKey ===
              `reconciliation-escalated:${targetExecutionId}:${hit.invocationId}`,
        );
        expect(visibleEscalations).toHaveLength(1);
        expect(visibleEscalations[0]).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: project.rootWorkspaceId,
        });
      }
      const recoveredApproval = readExecutableApprovalAfterRecovery(
        fixture.databaseFile,
        executableApproval.approvalId,
        targetExecutionId,
      );
      expect(recoveredApproval.approval).toMatchObject({
        state: "Consumed",
        consumed_by: hit.invocationId,
      });
      expect(recoveredApproval.approvals).toHaveLength(1);
      if (reconciliationDrift === "authority") {
        expect(
          readProjectActiveGrantCount(fixture.databaseFile, targetExecutionId),
        ).toBe(0);
      } else if (reconciliationDrift === "approval") {
        expect(recoveredApproval.approval.expires_at).toBe(
          "2000-01-01T00:00:00.000Z",
        );
      } else if (reconciliationDrift === "stop") {
        expect(
          (
            recovered.executions as Array<{
              execution_id: string;
              stop_requested_at: string | null;
            }>
          ).find((execution) => execution.execution_id === targetExecutionId)
            ?.stop_requested_at,
        ).not.toBeNull();
      }
      if (profileDrift !== undefined) {
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
      } else if (resumesUnadmittedIntent) {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("Success");
      } else if (noEffectRetryDenied) {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("ReconciledNoEffect");
      } else if (mismatchedProofIsUnknown) {
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
      } else if (
        reconciliationMode === "NotOccurred" ||
        reconciliationMode === "Occurred"
      ) {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("Success");
      } else if (semantics === "NonIdempotent") {
        expect(recoveredInvocationBinding?.effect_admission_state).toBe(
          "MayHaveStarted",
        );
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
        expect(settledInvocation?.settlement_json).toBeNull();
      } else {
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
        expect(settledInvocation?.settlement_json).toBeNull();
      }
      const recoveredTargetActions = recovered.actions.filter(
        (action) =>
          action.execution_id === targetExecutionId &&
          action.call_ref === hit.callRef,
      );
      if (noEffectRetryDenied) {
        expect(recoveredTargetActions).toHaveLength(1);
        expect(recoveredTargetActions[0]).toMatchObject({
          execution_id: targetExecutionId,
          logical_action_id: crashedAction.logical_action_id,
          call_ref: crashedAction.call_ref,
        });
        // The P4 denial may already be visible as a terminal rejection, but
        // this case qualifies the P4 retry gate only, not P3 projection crash
        // convergence. In particular, it must never report an applied effect.
        expect(recoveredTargetActions[0]?.state).not.toBe("Applied");
      } else {
        expect(recoveredTargetActions).toEqual([
          expect.objectContaining({
            execution_id: targetExecutionId,
            logical_action_id: crashedAction.logical_action_id,
            call_ref: crashedAction.call_ref,
            state:
              profileDrift !== undefined || mismatchedProofIsUnknown
                ? "ReconciliationPending"
                : resumesUnadmittedIntent ||
                    reconciliationMode === "NotOccurred" ||
                    reconciliationMode === "Occurred"
                  ? "Applied"
                  : "ReconciliationPending",
          }),
        ]);
      }
      const recoveredExecution = recovered.executions.find(
        (execution) => execution.execution_id === targetExecutionId,
      );
      const contentAfter = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      if (
        profileDrift !== undefined ||
        mismatchedProofIsUnknown ||
        (!resumesUnadmittedIntent && reconciliationMode === "StillUnknown")
      ) {
        if (mismatchedProofIsUnknown) {
          expect([null, "OutcomeUnknown"]).toContain(
            recoveredExecution?.settlement_kind,
          );
          if (recoveredExecution?.settlement_kind === "OutcomeUnknown") {
            expect(
              JSON.parse(String(recoveredExecution.settlement_json)),
            ).toEqual({
              _tag: "OutcomeUnknown",
              reconciliation: {
                _tag: "ReconciliationRequired",
                invocationRefs: [hit?.invocationId],
              },
            });
          }
        } else {
          expect(recoveredExecution).toMatchObject({
            settlement_kind: "OutcomeUnknown",
          });
          expect(
            JSON.parse(String(recoveredExecution?.settlement_json)),
          ).toEqual({
            _tag: "OutcomeUnknown",
            reconciliation: {
              _tag: "ReconciliationRequired",
              invocationRefs: [hit?.invocationId],
            },
          });
        }
      }
      if (semantics === "NonIdempotent" && !resumesUnadmittedIntent) {
        const toolResultsForCall = recovered.toolResults.filter(
          (row) => readToolResultForCall([row], targetCallRef) !== undefined,
        );
        expect(toolResultsForCall).toHaveLength(1);
        const unresolvedToolResult = readToolResultForCall(
          recovered.toolResults,
          targetCallRef,
        );
        expect(unresolvedToolResult).toBeDefined();
        expect(unresolvedToolResult?.row.source_kind).toBe("AgentLoopAction");
        expect(unresolvedToolResult?.payload).toMatchObject({
          _tag: "ToolResult",
          callRef: targetCallRef,
          toolName: "shell",
          status: "OutcomeUnknown",
          artifactRefs: [],
          truncated: false,
        });
        expect(unresolvedToolResult?.payload).not.toHaveProperty(
          "canonicalRefs",
        );
        expect(unresolvedToolResult?.payload).not.toHaveProperty("resultRef");
        expect(unresolvedToolResult?.payload).not.toHaveProperty(
          "invocationId",
        );
        expect(unresolvedToolResult?.row.source_ref).toBe(
          recoveredTargetActions[0]?.observation_source_ref,
        );
        expect(unresolvedToolResult?.payload.observationRef).toBe(
          recoveredTargetActions[0]?.observation_source_ref,
        );
        expect(
          recovered.artifacts.filter(
            (artifact) => artifact.invocation_id === hit.invocationId,
          ),
        ).toEqual([]);
      }
      const recoveredSourceStep = recovered.steps.find(
        (step) =>
          step.execution_id === targetExecutionId &&
          step.logical_step_no === crashedAction.logical_step_no &&
          step.repair_attempt === crashedAction.repair_attempt,
      );
      expect(crashedSourceStep).toMatchObject({
        state: "ActionsInProgress",
        next_action_index: 0,
        provider_turn_id: expect.any(String),
        decoded_output_hash: expect.any(String),
        model_output_session_sequence: expect.any(Number),
      });
      expect(recoveredSourceStep).toMatchObject({
        provider_turn_id: crashedSourceStep?.provider_turn_id,
        decoded_output_hash: crashedSourceStep?.decoded_output_hash,
        model_output_session_sequence:
          crashedSourceStep?.model_output_session_sequence,
      });
      const recoveredActionCursor = recoveredSourceStep?.next_action_index;
      if (
        recoveryCrashBoundary === "AH7BeforeToolSettlementCommit" ||
        recoveryCrashBoundary === "AH7AfterToolSettlementCommit"
      ) {
        expect([0, 1]).toContain(recoveredActionCursor);
      } else {
        expect(recoveredActionCursor).toBe(1);
      }
      expect(
        crashed.outputs.filter(
          (output) =>
            output.source_ref === `${originalProviderTurnId}:assistant`,
        ),
      ).toHaveLength(1);
      expect(
        recovered.outputs.filter(
          (output) =>
            output.source_ref === `${originalProviderTurnId}:assistant`,
        ),
      ).toHaveLength(1);
      expect(
        recovered.attempts.filter(
          (attempt) => attempt.provider_turn_id === originalProviderTurnId,
        ),
      ).toEqual(
        crashed.attempts.filter(
          (attempt) => attempt.provider_turn_id === originalProviderTurnId,
        ),
      );
      if (resumesUnadmittedIntent) {
        expect(
          recoveredTarget.providerTurns.find(
            (turn) => turn.provider_turn_id === originalProviderTurnId,
          ),
        ).toEqual(
          crashedTarget.providerTurns.find(
            (turn) => turn.provider_turn_id === originalProviderTurnId,
          ),
        );
        const successorTurn = recoveredTarget.providerTurns.find(
          (turn) => turn.provider_turn_id !== originalProviderTurnId,
        );
        expect(successorTurn?.settled_at).not.toBeNull();
        expect(
          recovered.outputs.filter(
            (output) =>
              output.source_ref ===
              `${successorTurn?.provider_turn_id}:assistant`,
          ),
        ).toHaveLength(1);
        expect(recoveredSourceStep?.next_action_index).toBe(1);
        expect(
          recovered.actions.find(
            (action) =>
              action.execution_id === targetExecutionId &&
              action.call_ref === hit?.callRef,
          )?.observation_source_ref,
        ).toEqual(expect.any(String));
        expect(
          recovered.toolResults.filter((row) =>
            isToolResultFor(row, hit?.invocationId ?? "", hit?.callRef ?? ""),
          ),
        ).toHaveLength(1);
        expect(targetProviderCalls).toBeGreaterThan(1);
        expect(contentBefore).toBeNull();
        expect(
          (contentAfter ?? "")
            .split(/\r?\n/u)
            .filter((line) => line === marker),
        ).toHaveLength(1);
      } else if (profileDrift !== undefined) {
        expect(recoveredTarget.providerTurns).toEqual(
          crashedTarget.providerTurns,
        );
        expect(targetProviderCalls).toBe(1);
        expect(contentAfter).toBeNull();
      } else if (mismatchedProofIsUnknown) {
        expect(recoveredTarget.providerTurns).toEqual(
          crashedTarget.providerTurns,
        );
        expect(targetProviderCalls).toBe(1);
        expect(contentAfter).toBeNull();
      } else if (
        reconciliationMode === "NotOccurred" ||
        reconciliationMode === "Occurred"
      ) {
        expect(
          recoveredTarget.providerTurns.filter((turn) =>
            crashedTarget.providerTurns.some(
              (crashedTurn) =>
                crashedTurn.provider_turn_id === turn.provider_turn_id,
            ),
          ),
        ).toEqual(crashedTarget.providerTurns);
        expect(targetProviderCalls).toBeLessThanOrEqual(2);
        if (noEffectRetryDenied) {
          expect(contentAfter).toBeNull();
          expect(externalEffects).toHaveLength(0);
        } else {
          expect(contentAfter).toBeDefined();
          expect(
            (contentAfter ?? "")
              .split(/\r?\n/u)
              .filter((line) => line === marker),
          ).toHaveLength(1);
        }
      } else {
        expect(recoveredTarget.providerTurns).toEqual(
          crashedTarget.providerTurns,
        );
        expect(targetProviderCalls).toBe(1);
        expect(contentAfter).toBe(contentBefore);
        if (semantics === "NonIdempotent") {
          expect(
            (contentAfter ?? "")
              .split(/\r?\n/u)
              .filter((line) => line === marker),
          ).toHaveLength(1);
        }
      }
      expect(fixture.daemonErrors).toEqual([]);
    });
  }
});
