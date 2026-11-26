import { DatabaseSync } from "node:sqlite";

export const readAh7FailureSnapshot = (
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
