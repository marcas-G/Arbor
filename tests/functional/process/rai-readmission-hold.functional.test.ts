import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { P37Probe } from "../support/p37-deliver-process-fixture.js";
import {
  awaitP37Probe,
  expireP37LeaseForQualification,
  findDeliverReplayFact,
  fixtures,
  p37Child,
  p37LeaseOwnerEvidence,
  persistRaiFailureEvidence,
  publicDeliverReplayRows,
  readP37Snapshot,
  readPublicAttention,
  readRaiBoundaryDiagnostic,
  releaseP37Gate,
  restartP37Normally,
  seedDeliverableWaitingForDelivery,
  startP37RecoveryDaemon,
} from "../support/p37-deliver-process-fixture.js";
import { makePublicClient, waitForPublic } from "../support/public-client.js";

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("pending RAI-DG-01 Work readmission process journeys", () => {
  it("keeps the original Work revision held after the P37 Inbox mismatch is ACKed and RuntimeSafetyStop settles", async () => {
    const marker = `RAI-DG-01-REV1-${crypto.randomUUID().slice(0, 8)}`;
    const seed = await seedDeliverableWaitingForDelivery(marker, {
      startDeliverImmediately: true,
    });
    const initialRevision = seed.seededWork.revision;
    const workId = seed.seededWork.workId;
    if (workId === undefined) throw new Error("RAI target WorkId missing");
    const firstReceipt = readP37Snapshot(seed.fixture.databaseFile);
    const firstAction = firstReceipt.actions.find(
      (action) => action.action_kind === "deliver",
    ) as
      | {
          execution_id: string;
          provider_turn_id: string;
          logical_action_id: string;
          observation_source_ref: string | null;
        }
      | undefined;
    expect(firstAction).toBeDefined();
    expect(firstAction?.logical_action_id).toMatch(/^lac_/u);
    const firstWorkExecution = firstReceipt.executions.filter(
      (execution) => execution.episode_ref === seed.seededWork.workId,
    );
    expect(firstWorkExecution).toHaveLength(1);
    expect(firstWorkExecution[0]).toMatchObject({
      episode_ref: seed.seededWork.workId,
      episode_revision: initialRevision,
    });
    if (firstAction === undefined) throw new Error("P37 action missing");

    await seed.fixture.crash();
    const inboxDb = new DatabaseSync(seed.fixture.databaseFile);
    try {
      const changed = inboxDb
        .prepare(
          "UPDATE inbox_entries SET summary = 'RAI-DG-01 deliberate mismatch' WHERE entry_key = ?",
        )
        .run(
          `msg:${(firstReceipt.messages[0] as { message_id: string }).message_id}`,
        );
      expect(Number(changed.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    const oldDaemon = {
      crash: seed.fixture.crash,
      snapshot: seed.fixture.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: seed.fixture.databaseFile,
      executionId: firstAction.execution_id,
      daemon: oldDaemon,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: seed.probes,
        executionId: firstAction.execution_id,
        daemon: oldDaemon,
      }),
    });

    const d4Threshold = 1;
    const providerRequestBaselineCount = seed.fixture.providerCalls.length;
    const recovery = await startP37RecoveryDaemon(
      seed.fixture,
      "new",
      seed.probes,
      "AfterDeliverReplayAttentionCommit,P10AfterAttentionRowWriteBeforeConsumerCommit,P37AfterSettlementCommit",
      d4Threshold,
      true,
      firstAction.execution_id,
      seed.daemonStdoutLines,
    );
    const recoveryClient = makePublicClient(recovery.baseUrl);
    let p9Failure: P37Probe | undefined;
    try {
      p9Failure = await awaitP37Probe(
        seed.probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === "AfterDeliverReplayAttentionCommit" &&
          probe.executionId === firstAction.execution_id &&
          probe.logicalActionId === firstAction.logical_action_id,
      );
    } catch (error) {
      const diagnostic = readP37Snapshot(seed.fixture.databaseFile);
      const diagnosticClient = makePublicClient(recovery.baseUrl);
      const targetExecution = diagnostic.executions.find(
        (execution) => execution.execution_id === firstAction.execution_id,
      );
      let publicCurrentWork: Record<string, unknown> | null = null;
      try {
        const currentWork = await diagnosticClient.view<{
          workId?: string;
          revision?: number;
          status?: string;
          activeExecution?: { executionId?: string };
        } | null>("current-work", {
          workspaceId: seed.producer.workspaceId,
        });
        publicCurrentWork =
          currentWork === null
            ? null
            : {
                workId: currentWork.workId,
                revision: currentWork.revision,
                status: currentWork.status,
                activeExecutionId: currentWork.activeExecution?.executionId,
              };
      } catch {
        publicCurrentWork = null;
      }
      let publicAttention: ReadonlyArray<Record<string, unknown>> | null = null;
      try {
        publicAttention = (
          await readPublicAttention(diagnosticClient, seed.project.projectId)
        ).rows
          .slice(-12)
          .map((row) => ({
            source: row.source,
            severity: row.severity,
            targetWorkspaceId: row.targetWorkspaceId,
            dedupKey: row.dedupKey,
            failureCode: row.failureCode,
          }));
      } catch {
        publicAttention = null;
      }
      const relevantBoundaries = new Set([
        "BeforeDeliverReplayAttentionCommit",
        "AfterDeliverReplayAttentionCommit",
        "P10AfterAttentionRowWriteBeforeConsumerCommit",
        "P10AfterDeliverAttentionConsumerCommit",
        "P37AfterSettlementCommit",
      ]);
      const relevantProbes = seed.probes
        .filter(
          (probe) =>
            probe.role === "new" &&
            relevantBoundaries.has(probe.boundary) &&
            (probe.executionId === firstAction.execution_id ||
              probe.logicalActionId === firstAction.logical_action_id),
        )
        .slice(-12)
        .map((probe) => ({
          boundary: probe.boundary,
          executionId: probe.executionId,
          logicalActionId: probe.logicalActionId,
          attentionFactId: probe.attentionFactId,
          failureCode: probe.failureCode,
        }));
      const targetAction = diagnostic.actions.find(
        (action) => action.logical_action_id === firstAction.logical_action_id,
      );
      const targetFacts = diagnostic.facts
        .filter((factRow) => factRow.execution_id === firstAction.execution_id)
        .slice(-8)
        .map((factRow) => ({
          attentionFactId: factRow.attention_fact_id,
          eventId: factRow.event_id,
          logicalActionId: factRow.logical_action_id,
          messageId: factRow.message_id,
          failureCode: factRow.failure_code,
        }));
      const targetWorkRows = diagnostic.works
        .filter((work) => work.work_id === seed.seededWork.workId)
        .slice(-4)
        .map((work) => ({
          workId: work.work_id,
          projectId: work.project_id,
          workspaceId: work.workspace_id,
          revision: work.revision,
          lifecycle: work.lifecycle,
        }));
      const targetLeases = diagnostic.leases
        .filter((lease) => lease.execution_id === firstAction.execution_id)
        .slice(-2)
        .map((lease) => ({
          executionId: lease.execution_id,
          generation: lease.generation,
          expiresAt: lease.expires_at,
        }));
      throw new Error(
        `RAI P9 replay probe timeout; cause=${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(
          {
            target: {
              projectId: seed.project.projectId,
              workspaceId: seed.producer.workspaceId,
              workId: seed.seededWork.workId,
              workRevision: initialRevision,
              executionId: firstAction.execution_id,
              logicalActionId: firstAction.logical_action_id,
            },
            originalExecution: targetExecution
              ? {
                  executionId: targetExecution.execution_id,
                  episodeKind: targetExecution.episode_kind,
                  episodeRef: targetExecution.episode_ref,
                  episodeRevision: targetExecution.episode_revision,
                  settlementKind: targetExecution.settlement_kind,
                  hasRuntimeSafetyStop: String(
                    targetExecution.settlement_json ?? "",
                  ).includes("RuntimeSafetyStop"),
                }
              : null,
            originalAction: targetAction
              ? {
                  executionId: targetAction.execution_id,
                  logicalActionId: targetAction.logical_action_id,
                  actionKind: targetAction.action_kind,
                  actionState: targetAction.state,
                  stepState: targetAction.step_state,
                  stepRevision: targetAction.step_revision,
                  actionIndex: targetAction.action_index,
                }
              : null,
            p9Probes: relevantProbes,
            p9Facts: targetFacts,
            pendingFacts: diagnostic.pendingFacts
              .filter((pending) =>
                targetFacts.some(
                  (factRow) =>
                    factRow.attentionFactId === pending.attention_fact_id,
                ),
              )
              .slice(-8),
            p10Markers: diagnostic.markers
              .filter((markerRow) =>
                targetFacts.some(
                  (factRow) =>
                    factRow.attentionFactId === markerRow.attention_fact_id,
                ),
              )
              .slice(-8),
            attentionOffsets: diagnostic.attentionOffsets
              .filter((offset) => offset.project_id === seed.project.projectId)
              .slice(-2),
            targetWork: targetWorkRows,
            targetLease: targetLeases,
            publicCurrentWork,
            publicAttention,
            providerRequestCount: seed.fixture.providerCalls.length,
            providerRequestBaselineCount,
            maxNoProgressTurns: d4Threshold,
            recoveryDaemonErrorCount: recovery.daemonErrors.length,
          },
          null,
          0,
        )}`,
      );
    }
    expect(p9Failure?.failureCode).toBe("PriorReceiptResultMismatch");
    const factSnapshot = readP37Snapshot(seed.fixture.databaseFile);
    const fact = findDeliverReplayFact(
      factSnapshot,
      firstAction.logical_action_id,
      (firstReceipt.messages[0] as { message_id: string }).message_id,
    );
    expect(fact).toBeDefined();
    if (fact === undefined) throw new Error("P37 replay fact missing");

    const committedP9Event = factSnapshot.replayEvents.find(
      (event) => event.event_id === fact.event_id,
    );
    expect(committedP9Event).toBeDefined();
    if (committedP9Event === undefined) {
      throw new Error("P37 P9 event witness missing from committed snapshot");
    }
    expect(
      factSnapshot.pendingFacts.some(
        (pending) => pending.attention_fact_id === fact.attention_fact_id,
      ),
    ).toBe(true);
    expect(
      factSnapshot.markers.some(
        (markerRow) => markerRow.attention_fact_id === fact.attention_fact_id,
      ),
    ).toBe(false);
    expect(
      factSnapshot.replayEvents.filter(
        (event) => event.event_id === fact.event_id,
      ),
    ).toHaveLength(1);

    // Let the P10 consumer advance only after the P9 fact/event transaction is
    // visible in the durable snapshot.
    releaseP37Gate(
      seed.fixture,
      "new",
      "boundary-AfterDeliverReplayAttentionCommit",
    );
    const firstAfterP9Boundary = await waitForPublic(
      async () =>
        seed.probes.find(
          (probe) =>
            probe.role === "new" &&
            (probe.boundary ===
              "P10AfterAttentionRowWriteBeforeConsumerCommit" ||
              probe.boundary === "P37AfterSettlementCommit") &&
            (probe.executionId === firstAction.execution_id ||
              probe.attentionFactId === fact.attention_fact_id),
        ),
      (probe) => probe !== undefined,
    ).catch(async (error: unknown) => {
      const diagnostic = await readRaiBoundaryDiagnostic({
        databaseFile: seed.fixture.databaseFile,
        client: recoveryClient,
        projectId: seed.project.projectId,
        workspaceId: seed.producer.workspaceId,
        workId,
        workRevision: initialRevision,
        executionId: firstAction.execution_id,
        logicalActionId: firstAction.logical_action_id,
        probes: seed.probes,
        providerRequestCount: seed.fixture.providerCalls.length,
        providerRequestBaselineCount,
        maxNoProgressTurns: d4Threshold,
        daemonErrorCount: recovery.daemonErrors.length,
      });
      await recovery.crash();
      const evidenceDirectory = persistRaiFailureEvidence({
        databaseFile: seed.fixture.databaseFile,
        diagnostic,
        daemonErrors: recovery.daemonErrors,
      });
      throw new Error(
        `RAI P10 precommit/settlement probe timeout; cause=${error instanceof Error ? error.message : String(error)}; evidence=${evidenceDirectory}; diagnostic=${JSON.stringify(diagnostic)}`,
      );
    });
    if (firstAfterP9Boundary === undefined) {
      throw new Error("RAI P10/settlement boundary signal is absent");
    }
    if (firstAfterP9Boundary.boundary === "P37AfterSettlementCommit") {
      const diagnostic = await readRaiBoundaryDiagnostic({
        databaseFile: seed.fixture.databaseFile,
        client: recoveryClient,
        projectId: seed.project.projectId,
        workspaceId: seed.producer.workspaceId,
        workId,
        workRevision: initialRevision,
        executionId: firstAction.execution_id,
        logicalActionId: firstAction.logical_action_id,
        probes: seed.probes,
        providerRequestCount: seed.fixture.providerCalls.length,
        providerRequestBaselineCount,
        maxNoProgressTurns: d4Threshold,
        daemonErrorCount: recovery.daemonErrors.length,
      });
      await recovery.crash();
      const evidenceDirectory = persistRaiFailureEvidence({
        databaseFile: seed.fixture.databaseFile,
        diagnostic,
        daemonErrors: recovery.daemonErrors,
      });
      throw new Error(
        `RuntimeSafetyStop committed before P10 write/ACK; evidence=${evidenceDirectory}; stop rather than extending the wait; diagnostic=${JSON.stringify(diagnostic)}`,
      );
    }
    if (firstAfterP9Boundary.attentionFactId !== fact.attention_fact_id) {
      const diagnostic = await readRaiBoundaryDiagnostic({
        databaseFile: seed.fixture.databaseFile,
        client: recoveryClient,
        projectId: seed.project.projectId,
        workspaceId: seed.producer.workspaceId,
        workId,
        workRevision: initialRevision,
        executionId: firstAction.execution_id,
        logicalActionId: firstAction.logical_action_id,
        probes: seed.probes,
        providerRequestCount: seed.fixture.providerCalls.length,
        providerRequestBaselineCount,
        maxNoProgressTurns: d4Threshold,
        daemonErrorCount: recovery.daemonErrors.length,
      });
      throw new Error(
        `P10 precommit probe did not match exact P9 fact; diagnostic=${JSON.stringify(diagnostic)}`,
      );
    }
    const beforeP10Commit = readP37Snapshot(seed.fixture.databaseFile);
    expect(
      beforeP10Commit.pendingFacts.some(
        (pending) => pending.attention_fact_id === fact.attention_fact_id,
      ),
    ).toBe(true);
    expect(
      beforeP10Commit.markers.some(
        (markerRow) => markerRow.attention_fact_id === fact.attention_fact_id,
      ),
    ).toBe(false);
    const pendingP10Event = beforeP10Commit.replayEvents.find(
      (event) => event.event_id === fact.event_id,
    );
    expect(pendingP10Event?.sequence).toBe(committedP9Event.sequence);
    const offsetBeforeP10Commit = beforeP10Commit.attentionOffsets.find(
      (offset) => offset.project_id === seed.project.projectId,
    );
    expect(offsetBeforeP10Commit).toBeDefined();
    expect(Number(offsetBeforeP10Commit?.last_sequence)).toBeLessThan(
      Number(committedP9Event.sequence),
    );
    releaseP37Gate(
      seed.fixture,
      "new",
      "boundary-P10AfterAttentionRowWriteBeforeConsumerCommit",
    );

    const ackOrStop = await waitForPublic(
      async () => {
        const snapshot = readP37Snapshot(seed.fixture.databaseFile);
        return {
          snapshot,
          stop: seed.probes.find(
            (probe) =>
              probe.role === "new" &&
              probe.boundary === "P37AfterSettlementCommit" &&
              probe.executionId === firstAction.execution_id,
          ),
        };
      },
      ({ snapshot, stop }) =>
        stop !== undefined ||
        (snapshot.pendingFacts.every(
          (pending) => pending.attention_fact_id !== fact.attention_fact_id,
        ) &&
          snapshot.markers.some(
            (markerRow) =>
              markerRow.attention_fact_id === fact.attention_fact_id,
          )),
    ).catch(async (error: unknown) => {
      const diagnostic = await readRaiBoundaryDiagnostic({
        databaseFile: seed.fixture.databaseFile,
        client: recoveryClient,
        projectId: seed.project.projectId,
        workspaceId: seed.producer.workspaceId,
        workId,
        workRevision: initialRevision,
        executionId: firstAction.execution_id,
        logicalActionId: firstAction.logical_action_id,
        probes: seed.probes,
        providerRequestCount: seed.fixture.providerCalls.length,
        providerRequestBaselineCount,
        maxNoProgressTurns: d4Threshold,
        daemonErrorCount: recovery.daemonErrors.length,
      });
      await recovery.crash();
      const evidenceDirectory = persistRaiFailureEvidence({
        databaseFile: seed.fixture.databaseFile,
        diagnostic,
        daemonErrors: recovery.daemonErrors,
      });
      throw new Error(
        `RAI P10 ACK wait timeout; cause=${error instanceof Error ? error.message : String(error)}; evidence=${evidenceDirectory}; diagnostic=${JSON.stringify(diagnostic)}`,
      );
    });
    const acknowledged =
      !ackOrStop.snapshot.pendingFacts.some(
        (pending) => pending.attention_fact_id === fact.attention_fact_id,
      ) &&
      ackOrStop.snapshot.markers.some(
        (markerRow) => markerRow.attention_fact_id === fact.attention_fact_id,
      );
    if (!acknowledged) {
      const diagnostic = await readRaiBoundaryDiagnostic({
        databaseFile: seed.fixture.databaseFile,
        client: recoveryClient,
        projectId: seed.project.projectId,
        workspaceId: seed.producer.workspaceId,
        workId,
        workRevision: initialRevision,
        executionId: firstAction.execution_id,
        logicalActionId: firstAction.logical_action_id,
        probes: seed.probes,
        providerRequestCount: seed.fixture.providerCalls.length,
        providerRequestBaselineCount,
        maxNoProgressTurns: d4Threshold,
        daemonErrorCount: recovery.daemonErrors.length,
      });
      await recovery.crash();
      const evidenceDirectory = persistRaiFailureEvidence({
        databaseFile: seed.fixture.databaseFile,
        diagnostic,
        daemonErrors: recovery.daemonErrors,
      });
      throw new Error(
        `RuntimeSafetyStop committed before exact P10 ACK; evidence=${evidenceDirectory}; diagnostic=${JSON.stringify(diagnostic)}`,
      );
    }
    const acknowledgedEventOffset = ackOrStop.snapshot.attentionOffsets.find(
      (offset) => offset.project_id === seed.project.projectId,
    );
    expect(acknowledgedEventOffset).toBeDefined();
    expect(
      Number(acknowledgedEventOffset?.last_sequence),
    ).toBeGreaterThanOrEqual(Number(committedP9Event.sequence));
    const stopProbe = await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "P37AfterSettlementCommit" &&
        probe.executionId === firstAction.execution_id,
    );
    expect(stopProbe).toBeDefined();
    const atStop = readP37Snapshot(seed.fixture.databaseFile);
    const source = atStop.executions.find(
      (execution) => execution.execution_id === firstAction.execution_id,
    ) as { settlement_kind: string | null; settlement_json: string | null };
    expect(source.settlement_kind).toBe("Interrupted");
    expect(source.settlement_json).toContain("RuntimeSafetyStop");
    expect(
      atStop.executions.filter(
        (execution) =>
          execution.episode_ref === seed.seededWork.workId &&
          Number(execution.episode_revision) === initialRevision,
      ),
    ).toHaveLength(1);
    expect(atStop.facts).toHaveLength(1);
    expect(atStop.pendingFacts).toHaveLength(0);
    expect(atStop.markers).toContainEqual({
      attention_fact_id: fact.attention_fact_id,
    });
    expect(atStop.messages).toHaveLength(1);
    expect(atStop.deliverMessageReceipts).toHaveLength(1);

    // Kill immediately after the durable stop, then restart against the same
    // SQLite file. ACK and restart are housekeeping/recovery events only.
    const providerCallsAtStop = seed.fixture.providerCalls.length;
    await recovery.crash();
    try {
      await restartP37Normally(seed.fixture);
    } catch (error) {
      const diagnostic = await readRaiBoundaryDiagnostic({
        databaseFile: seed.fixture.databaseFile,
        client: recoveryClient,
        projectId: seed.project.projectId,
        workspaceId: seed.producer.workspaceId,
        workId,
        workRevision: initialRevision,
        executionId: firstAction.execution_id,
        logicalActionId: firstAction.logical_action_id,
        probes: seed.probes,
        providerRequestCount: seed.fixture.providerCalls.length,
        providerRequestBaselineCount,
        maxNoProgressTurns: d4Threshold,
        daemonErrorCount: recovery.daemonErrors.length,
      });
      const evidenceDirectory = persistRaiFailureEvidence({
        databaseFile: seed.fixture.databaseFile,
        diagnostic,
        daemonErrors: [...seed.fixture.daemonErrors, ...recovery.daemonErrors],
        daemonStdoutLines: seed.daemonStdoutLines,
        daemonProcessSnapshot: seed.fixture.daemonProcessSnapshot(),
      });
      throw new Error(
        `RAI restart handshake failed after P10 ACK/RuntimeSafetyStop; cause=${error instanceof Error ? error.message : String(error)}; evidence=${evidenceDirectory}; process=${JSON.stringify(seed.fixture.daemonProcessSnapshot())}`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const afterRestart = readP37Snapshot(seed.fixture.databaseFile);
    expect(
      afterRestart.executions.filter(
        (execution) =>
          execution.episode_ref === seed.seededWork.workId &&
          Number(execution.episode_revision) === initialRevision,
      ),
    ).toHaveLength(1);
    expect(afterRestart.deliverMessageReceipts).toHaveLength(1);
    expect(afterRestart.messages).toHaveLength(1);
    expect(afterRestart.facts).toHaveLength(1);
    expect(afterRestart.markers).toContainEqual({
      attention_fact_id: fact.attention_fact_id,
    });
    expect(seed.fixture.providerCalls).toHaveLength(providerCallsAtStop);

    const publicFactRows = await publicDeliverReplayRows(
      seed.client,
      seed.project.projectId,
    );
    expect(
      publicFactRows.some((row) => row.dedupKey === fact.attention_fact_id),
    ).toBe(true);
    const attentionAtStop = await readPublicAttention(
      seed.client,
      seed.project.projectId,
    );
    expect(
      attentionAtStop.rows.some(
        (row) =>
          row.source === "RuntimeSafetyEnvelope" &&
          row.dedupKey === `safety-stop:${firstAction.execution_id}`,
      ),
    ).toBe(true);

    await seed.client.command(seed.project.projectId, "SteerWork", {
      workId: seed.seededWork.workId,
      workspaceId: seed.producer.workspaceId,
      expectedWorkRevision: initialRevision,
      steer: {
        severity: "Normal",
        guidance: `Resume ${marker} at revision ${initialRevision + 1} after reviewing the P9 evidence.`,
      },
      provenance: { source: "HumanInput" },
    });
    const revisedWork = await waitForPublic(
      () =>
        seed.client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: seed.producer.workspaceId }),
      (work) =>
        work !== null &&
        work.workId === seed.seededWork.workId &&
        work.revision === initialRevision + 1,
    );
    expect(revisedWork?.status).toBe("Open");
    const postSteerRows = await readPublicAttention(
      seed.client,
      seed.project.projectId,
    );
    expect(
      postSteerRows.rows.some(
        (row) =>
          row.source === "DeliverReplayFailure" &&
          row.dedupKey === fact.attention_fact_id,
      ),
    ).toBe(false);
    expect(
      postSteerRows.rows.some(
        (row) =>
          row.source === "RuntimeSafetyEnvelope" &&
          row.dedupKey === `safety-stop:${firstAction.execution_id}`,
      ),
    ).toBe(false);
    const afterSteer = readP37Snapshot(seed.fixture.databaseFile);
    expect(afterSteer.facts).toHaveLength(1);
    expect(
      afterSteer.executions.some(
        (execution) =>
          execution.episode_ref === seed.seededWork.workId &&
          Number(execution.episode_revision) === initialRevision + 1,
      ),
    ).toBe(true);
  }, 240_000);

  it("keeps an ordinary RuntimeSafetyStop Work revision held without any P9 fact", async () => {
    const marker = `RAI-DG-01-SAFETY-ONLY-${crypto.randomUUID().slice(0, 8)}`;
    const seed = await seedDeliverableWaitingForDelivery(marker);
    const initialRevision = seed.seededWork.revision;
    const workId = seed.seededWork.workId;
    if (workId === undefined) throw new Error("RAI WorkId missing");
    expect(readP37Snapshot(seed.fixture.databaseFile).facts).toHaveLength(0);

    // Leave the Work in its durable Manual wait while replacing the daemon
    // with one whose test-only D4 threshold deterministically stops its next
    // Work turn. No P9 action or P10 row is used as the trigger.
    await seed.fixture.crash();
    await seed.fixture.restart({
      entry: p37Child,
      daemonEnvironment: {
        ARBOR_P37_ROLE: "new",
        ARBOR_P37_MAX_NO_PROGRESS_TURNS: "0",
        ARBOR_P37_SETTLEMENT_WORK_ID: workId,
        ARBOR_P37_SETTLEMENT_EPISODE_REVISION: String(initialRevision + 1),
        ARBOR_P37_PAUSE_ROLE: "new",
        ARBOR_P37_PAUSE_BOUNDARY: "P37AfterSettlementCommit",
      },
    });
    await seed.client.command(seed.project.projectId, "SteerWork", {
      workId: seed.seededWork.workId,
      workspaceId: seed.producer.workspaceId,
      expectedWorkRevision: initialRevision,
      steer: {
        severity: "Normal",
        guidance: `Resume ${marker} to qualify the safety-only hold.`,
      },
      provenance: { source: "HumanInput" },
    });
    const safetyStop = await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "new" && probe.boundary === "P37AfterSettlementCommit",
    );
    expect(safetyStop?.executionId).toBeDefined();
    const stopped = readP37Snapshot(seed.fixture.databaseFile);
    expect(stopped.facts).toHaveLength(0);
    expect(stopped.messages).toHaveLength(0);
    const safetyExecution = stopped.executions.find(
      (execution) => execution.execution_id === safetyStop?.executionId,
    ) as {
      episode_ref: string;
      episode_revision: number;
      settlement_json: string;
    };
    expect(safetyExecution).toMatchObject({
      episode_ref: seed.seededWork.workId,
      episode_revision: initialRevision + 1,
    });
    expect(safetyExecution.settlement_json).toContain("RuntimeSafetyStop");
    const stoppedExecutionId = safetyStop?.executionId;
    if (stoppedExecutionId === undefined)
      throw new Error("SafetyStop Execution missing");

    await seed.fixture.crash();
    await restartP37Normally(seed.fixture);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    const afterRestart = readP37Snapshot(seed.fixture.databaseFile);
    expect(afterRestart.facts).toHaveLength(0);
    expect(
      afterRestart.executions.filter(
        (execution) =>
          execution.episode_ref === seed.seededWork.workId &&
          Number(execution.episode_revision) === initialRevision + 1,
      ),
    ).toHaveLength(1);
    expect(
      afterRestart.executions.find(
        (execution) => execution.execution_id === stoppedExecutionId,
      )?.settlement_json,
    ).toContain("RuntimeSafetyStop");

    await seed.client.command(seed.project.projectId, "SteerWork", {
      workId: seed.seededWork.workId,
      workspaceId: seed.producer.workspaceId,
      expectedWorkRevision: initialRevision + 1,
      steer: {
        severity: "Normal",
        guidance: `Advance ${marker} past the safety-only hold.`,
      },
      provenance: { source: "HumanInput" },
    });
    const revision3 = await waitForPublic(
      () =>
        seed.client.view<{
          workId?: string;
          revision: number;
        } | null>("current-work", { workspaceId: seed.producer.workspaceId }),
      (work) =>
        work !== null &&
        work.workId === seed.seededWork.workId &&
        work.revision === initialRevision + 2,
    );
    expect(revision3?.revision).toBe(initialRevision + 2);
    const afterSteer = await waitForPublic(
      async () => readP37Snapshot(seed.fixture.databaseFile),
      (snapshot) =>
        snapshot.executions.some(
          (execution) =>
            execution.episode_ref === seed.seededWork.workId &&
            Number(execution.episode_revision) === initialRevision + 2,
        ),
    );
    expect(afterSteer.facts).toHaveLength(0);
  }, 180_000);
});
