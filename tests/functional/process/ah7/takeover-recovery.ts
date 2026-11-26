import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { recordAhProbeLine } from "../../support/ah-probe-line.js";
import { waitForPublic } from "../../support/public-client.js";
import type { Ah7CrashContext } from "./start-fixture.js";
import {
  readEffectAttempts,
  readP4InvocationApprovalBinding,
  readReconciliationFacts,
  readTestExternalEffects,
  readTestReconciliationCalls,
  readTestReconciliationSourceReturns,
  readToolResultForCall,
  reconciliationChild,
  waitForOldReconciliationCallReturn,
} from "./support.js";

export const runAh7G0G1TakeoverRecovery = async (
  ctx: Ah7CrashContext,
): Promise<void> => {
  const {
    fixture,
    client,
    project,
    hit,
    targetExecutionId,
    targetInvocationId,
    effectFile,
  } = ctx;
  const { reconciliationMode, proofMismatch, mismatchedProofIsUnknown } =
    ctx.flags;
  if (reconciliationMode === undefined)
    throw new Error(
      "AH7 G0/G1 takeover recovery requires a reconciliation mode",
    );
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
      ctx.processEvents.find(
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
    ctx.oldLeaseGeneration = gen0Generation;
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
      ctx.additionalDaemonStdout.push(line);
      recordAhProbeLine(ctx.hits, line);
      try {
        ctx.processEvents.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Ignore non-JSON daemon output in this test-only trace.
      }
    },
  });
  ctx.gen1DaemonForDiagnostic = gen1Daemon;
  const gen1Lease = await waitForPublic(
    async () =>
      ctx.processEvents.find(
        (event) =>
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.role === "new" &&
          event.executionId === targetExecutionId,
      ),
    (event) => event !== undefined,
    45_000,
  );
  ctx.newLeaseGeneration = Number(gen1Lease?.fencingGeneration);
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
      ctx.processEvents.find(
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
    const toolResultsAtP3Commit = p3CommittedByGen1.toolResults.filter((row) =>
      readToolResultForCall([row], hit?.callRef ?? ""),
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
    const leaseBeforeStaleReturn = new DatabaseSync(fixture.databaseFile, {
      readOnly: true,
    });
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
        ctx.processEvents.find(
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
    expect(executionBeforeStaleReturn?.settlement_kind).toBe("OutcomeUnknown");
    const toolResultsBeforeStaleReturn = unresolvedByGen1.toolResults.filter(
      (row) => readToolResultForCall([row], hit?.callRef ?? ""),
    );
    expect(toolResultsBeforeStaleReturn).toHaveLength(1);
    expect(toolResultsBeforeStaleReturn).toEqual(toolResultsAtP3Commit);
    writeFileSync(
      join(fixture.directory, "ah10-gates", "old-reconciliation-io.release"),
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
      ctx.oldSourceReturnElapsedMs = oldSourceReturn.elapsedMs;
      ctx.oldSourceReturnRows = oldSourceReturn.records;
      waitingFor = "old-result-fence";
      staleResultFence = await waitForPublic(
        async () =>
          ctx.processEvents.find(
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
        identity: ctx.failureIdentity,
        oldGeneration: ctx.oldLeaseGeneration,
        newGeneration: ctx.newLeaseGeneration,
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
        reconciliationSourceRows: ctx.failureIdentity
          ? readTestReconciliationCalls(
              fixture.databaseFile,
              ctx.failureIdentity.invocationId,
            )
          : [],
        reconciliationSourceReturns: ctx.failureIdentity
          ? readTestReconciliationSourceReturns(
              join(fixture.directory, "ah10-gates"),
              ctx.failureIdentity.invocationId,
            )
          : [],
        state: ctx.lifecycle.takeoverFailureDiagnostic.get(fixture)?.() ?? null,
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
          writeError instanceof Error ? writeError.message : String(writeError);
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
    const snapshotAfterStaleReturn = durableSnapshot(fixture.databaseFile);
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
      join(fixture.directory, "ah10-gates", "old-reconciliation-io.release"),
      "release stale gen0 source result",
    );
    const oldSourceReturn = await waitForOldReconciliationCallReturn(
      join(fixture.directory, "ah10-gates"),
      fixture.databaseFile,
      targetInvocationId,
    );
    ctx.oldSourceReturnElapsedMs = oldSourceReturn.elapsedMs;
    ctx.oldSourceReturnRows = oldSourceReturn.records;
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
      expect(attempts.map((attempt) => attempt.attempt_no)).toEqual([0, 1]);
      expect(attempts.map((attempt) => attempt.admission_state)).toEqual([
        "MayHaveStarted",
        "MayHaveStarted",
      ]);
    } finally {
      takeoverDb.close();
    }
  }
  await gen1Daemon.crash();
};
