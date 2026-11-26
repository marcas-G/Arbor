import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect } from "vitest";
import { SHELL_DEFINITION } from "../../../../packages/tool-runtime/src/catalog.js";
import { archiveProductionFixtureFailure } from "../../support/fixture-failure-evidence.js";
import type { ProductionFixture } from "../../support/production-fixture.js";
import {
  type makePublicClient,
  waitForExecutableApproval,
  waitForPublic,
} from "../../support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../support/schema44-bootstrap.js";

// This bounds the test's wait for a paused child-process source call to return;
// it is not the duration or acceptance deadline for a reconciliation result.
const AH7_CROSS_PROCESS_SOURCE_IO_OBSERVATION_BUDGET_MS = 60_000;
export const crashChild = resolve(
  "tests/functional/support/ah-crash-child.mjs",
);
export const reconciliationChild = resolve(
  "tests/functional/support/ah10-process-child.mjs",
);

export const readExecutionProviderTurns = (
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

export const isToolResultFor = (
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

export const readToolResultForCall = (
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

export interface ExecutableApprovalQualification {
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

export const waitForExactShellApproval = async (input: {
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

export const readExecutableApprovalAfterRecovery = (
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

export const readProjectActiveGrantCount = (
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

export const readP4InvocationApprovalBinding = (
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

export const readP39RecoveryBinding = (
  databaseFile: string,
  invocationId: string,
) => {
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

export const readReconciliationFacts = (
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

export const readEffectAttempts = (
  databaseFile: string,
  invocationId: string,
) => {
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

export const readTestExternalEffects = (databaseFile: string) => {
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

export const readTestReconciliationCallCount = (
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

export const readTestReconciliationCalls = (
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

export const readTestReconciliationSourceReturns = (
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

export const findExactSourceReturn = (
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

export const waitForReconciliationSourceReturn = async (
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

export const waitForOldReconciliationCallReturn = (
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

export interface Ah7FixtureLifecycle {
  readonly fixtures: ProductionFixture[];
  readonly preservedTakeoverFailureFixtures: Set<ProductionFixture>;
  readonly takeoverFailureDiagnostic: Map<
    ProductionFixture,
    () => Readonly<Record<string, unknown>>
  >;
}

export const createAh7FixtureLifecycle = (): Ah7FixtureLifecycle => {
  const fixtures: ProductionFixture[] = [];
  const preservedTakeoverFailureFixtures = new Set<ProductionFixture>();
  const takeoverFailureDiagnostic = new Map<
    ProductionFixture,
    () => Readonly<Record<string, unknown>>
  >();
  afterEach(async ({ task }) => {
    const testFailed = (task.result?.errors?.length ?? 0) > 0;
    for (const fixture of fixtures.splice(0)) {
      const preserveOnFailure =
        preservedTakeoverFailureFixtures.delete(fixture);
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
          const captured = diagnostic?.() ?? null;
          const archivedDirectory = archiveProductionFixtureFailure({
            fixture,
            resultDirectory,
            artifactPrefix: "ah7-reconcilable-takeover",
            evidence: {
              testName: task.name,
              primaryDaemon: fixture.daemonProcessSnapshot(),
              primaryDaemonStderr: fixture.daemonErrors,
              captured,
              cleanupError:
                stopError instanceof Error ? stopError.message : undefined,
            },
          });
          process.stdout.write(
            `[AH7_FAILURE_ARTIFACT] ${JSON.stringify({ testName: task.name, archivedDirectory, primaryDaemon: fixture.daemonProcessSnapshot(), primaryDaemonStderr: fixture.daemonErrors, additionalDaemon: (captured as { additionalDaemon?: unknown } | null)?.additionalDaemon })}\n`,
          );
        } else {
          removeFunctionalFixtureDirectory(fixture.directory);
        }
      }
      if (stopError !== undefined) throw stopError;
    }
  });
  return {
    fixtures,
    preservedTakeoverFailureFixtures,
    takeoverFailureDiagnostic,
  };
};
