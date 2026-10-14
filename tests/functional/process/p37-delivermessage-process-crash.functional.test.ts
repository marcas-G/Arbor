import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { P37Probe } from "../support/p37-deliver-process-fixture.js";
import {
  awaitP37Probe,
  deliverAndHoldCommittedReceipt,
  expectedDeliverCommandId,
  expectedDeliverMessageId,
  expireP37LeaseForQualification,
  findDeliverReplayFact,
  fixtures,
  p37Child,
  p37LeaseOwnerEvidence,
  prepareContradictoryCommittedReceipt,
  publicDeliverReplayRows,
  readP37Snapshot,
  recordP37Probe,
  releaseP37Gate,
  restartP37Normally,
  seedDeliverableWaitingForDelivery,
  startP37RecoveryDaemon,
} from "../support/p37-deliver-process-fixture.js";
import { makePublicClient, waitForPublic } from "../support/public-client.js";

afterEach(async ({ task }) => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.stop();
    process.stdout.write(
      `${JSON.stringify({
        tag: "P37_L6_FIXTURE_ARTIFACT",
        test: task.name,
        directory: fixture.directory,
        databaseFile: fixture.databaseFile,
        daemonErrors: fixture.daemonErrors,
        daemonProcessSnapshot: fixture.daemonProcessSnapshot(),
      })}\n`,
    );
  }
});
describe("pending P37 L6 DeliverMessage real-process crash matrix", () => {
  it.each(["before", "after"] as const)(
    "kills gen0 %s its FencingRejected receipt commit; gen1 commits the same logical delivery once",
    async (crashSide) => {
      const marker = `P37-L6-FENCE-${crashSide}-${crypto.randomUUID().slice(0, 8)}`;
      const seed = await seedDeliverableWaitingForDelivery(marker);
      const { fixture, client, producer, seededWork, probes } = seed;
      seed.armDeliver();
      await fixture.crash();
      const oldBoundaries = [
        "AH7AfterActionIntentCommit",
        "AH10BeforeLeaseRenewal",
        crashSide === "before"
          ? "AH10BeforeFencedReceiptCommit"
          : "AH10AfterControlHandlerReturnBeforeObservationCommit",
      ].join(",");
      await fixture.restart({
        entry: p37Child,
        daemonEnvironment: {
          ARBOR_P37_ROLE: "old",
          ARBOR_P37_PAUSE_ROLE: "old",
          ARBOR_P37_PAUSE_BOUNDARY: oldBoundaries,
          ARBOR_P37_GATE_ACTION_KIND: "deliver",
        },
      });
      await client.command(seed.project.projectId, "SteerWork", {
        workId: seededWork.workId,
        workspaceId: producer.workspaceId,
        expectedWorkRevision: seededWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume the measured Deliver action ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });

      const oldAction = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "old" &&
          probe.boundary === "AH7AfterActionIntentCommit" &&
          probe.actionKind === "deliver",
      );
      if (oldAction === undefined || oldAction.executionId === undefined) {
        throw new Error("P37 gen0 Deliver action intent probe is absent");
      }
      expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
      expect(oldAction.logicalActionId).toMatch(/^lac_/u);

      const oldRenewal = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "old" &&
          probe.boundary === "AH10BeforeLeaseRenewal" &&
          probe.executionId === oldAction.executionId,
      );
      expect(oldRenewal?.executionId).toBe(oldAction.executionId);

      await waitForPublic(
        async () =>
          readP37Snapshot(fixture.databaseFile).leases.find(
            (lease) =>
              (lease as { execution_id: string }).execution_id ===
              oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined &&
          Date.parse((lease as { expires_at: string }).expires_at) <=
            Date.now(),
        40_000,
      );
      const newDaemon = await fixture.startAdditionalDaemon({
        entry: p37Child,
        daemonEnvironment: {
          ARBOR_P37_ROLE: "new",
          ARBOR_P37_PAUSE_ROLE: "new",
          ARBOR_P37_PAUSE_BOUNDARY: "AH7AfterActionIntentCommit",
          ARBOR_P37_GATE_ACTION_KIND: "deliver",
        },
        onStdout: (line) => {
          try {
            const probe = JSON.parse(line) as P37Probe;
            if (probe.tag === "P37_DELIVER_PROBE")
              recordP37Probe(probes, probe);
          } catch {
            // The fixture retains stderr; unrelated stdout is not a P37 signal.
          }
        },
      });
      const newLease = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === "AH10AfterLeaseAcquired" &&
          probe.executionId === oldAction.executionId,
      );
      expect(newLease?.fencingGeneration).toBe(1);
      const newAction = await awaitP37Probe(
        probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === "AH7AfterActionIntentCommit" &&
          probe.executionId === oldAction.executionId &&
          probe.actionKind === "deliver",
      );
      expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
      expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

      releaseP37Gate(fixture, "old", "boundary-AH7AfterActionIntentCommit");
      let oldPrecommitCommandId: string | undefined;
      if (crashSide === "before") {
        const oldPrecommit = await awaitP37Probe(
          probes,
          (probe) =>
            probe.role === "old" &&
            probe.boundary === "AH10BeforeFencedReceiptCommit" &&
            probe.executionId === oldAction.executionId,
        );
        expect(oldPrecommit?.commandId).toMatch(/^cmd_/u);
        oldPrecommitCommandId = oldPrecommit?.commandId;
        const uncommittedSnapshot = readP37Snapshot(fixture.databaseFile);
        expect(
          uncommittedSnapshot.commands.filter(
            (row) =>
              row.resolution === "TerminalRejected" &&
              String(row.terminal_error_json).includes("FencingRejected"),
          ),
        ).toHaveLength(0);
        await fixture.crash();
      } else {
        const afterCommit = await awaitP37Probe(
          probes,
          (probe) =>
            probe.role === "old" &&
            probe.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            probe.actionKind === "deliver" &&
            probe.logicalActionId === oldAction.logicalActionId &&
            probe.executionId === oldAction.executionId,
        );
        expect(afterCommit?.logicalActionId).toBe(oldAction.logicalActionId);
        const committedSnapshot = readP37Snapshot(fixture.databaseFile);
        const rejectedReceipt = committedSnapshot.commands.find(
          (row) =>
            row.resolution === "TerminalRejected" &&
            String(row.terminal_error_json).includes("FencingRejected"),
        );
        expect(rejectedReceipt).toBeDefined();
        oldPrecommitCommandId = (rejectedReceipt as { command_id: string })
          .command_id;
        await fixture.crash();
      }

      releaseP37Gate(fixture, "new", "boundary-AH7AfterActionIntentCommit");
      const newActionTurn = await waitForPublic(
        async () => readP37Snapshot(fixture.databaseFile),
        (snapshot) =>
          snapshot.actions.some(
            (action) =>
              (action as { logical_action_id?: string }).logical_action_id ===
                oldAction.logicalActionId &&
              (action as { state?: string }).state === "Applied",
          ),
        60_000,
      );
      const oldRejects = newActionTurn.commands.filter(
        (row) =>
          row.resolution === "TerminalRejected" &&
          String(row.terminal_error_json).includes("FencingRejected"),
      );
      const committed = newActionTurn.deliverMessageReceipts.filter(
        (row) => row.resolution === "Committed",
      );
      expect(oldRejects).toHaveLength(crashSide === "before" ? 0 : 1);
      expect(committed).toHaveLength(1);
      const gen1CommandId = (committed[0] as { command_id: string }).command_id;
      expect(gen1CommandId).toBe(
        expectedDeliverCommandId(oldAction.providerTurnId as string, 1),
      );
      if (crashSide === "before") {
        expect(oldPrecommitCommandId).toBe(
          expectedDeliverCommandId(oldAction.providerTurnId as string, 0),
        );
        expect(gen1CommandId).not.toBe(oldPrecommitCommandId);
      }
      if (crashSide === "after") {
        expect((oldRejects[0] as { command_id: string }).command_id).toBe(
          expectedDeliverCommandId(oldAction.providerTurnId as string, 0),
        );
        expect(oldRejects[0]).toMatchObject({
          command_id: oldPrecommitCommandId,
        });
      }
      expect(newActionTurn.messages).toHaveLength(1);
      expect(
        (newActionTurn.messages[0] as { message_id: string }).message_id,
      ).toBe(expectedDeliverMessageId(oldAction.providerTurnId as string));
      expect(newActionTurn.messageEvents).toHaveLength(1);
      expect(newActionTurn.inbox).toHaveLength(1);
      const applied = newActionTurn.actions[0] as {
        execution_id: string;
        provider_turn_id: string;
        logical_action_id: string;
        observation_source_ref: string;
      };
      expect(applied.execution_id).toBe(oldAction.executionId);
      expect(applied.provider_turn_id).toBe(oldAction.providerTurnId);
      expect(applied.logical_action_id).toBe(oldAction.logicalActionId);
      expect(
        newActionTurn.observations.filter(
          (observation) =>
            (observation as { source_ref: string }).source_ref ===
            applied.observation_source_ref,
        ),
      ).toHaveLength(1);
      expect(seed.deliverDecisionCalls).toBe(1);
      expect(newDaemon.daemonErrors).toEqual([]);
    },
    180_000,
  );
  it("converges a committed DeliverMessage after killing the daemon before Action/Observation commit", async () => {
    const marker = `P37-L6-RECEIPT-${crypto.randomUUID().slice(0, 8)}`;
    const seed = await seedDeliverableWaitingForDelivery(marker);
    const { fixture, client, producer, seededWork, probes } = seed;
    seed.armDeliver();
    await fixture.crash();
    await fixture.restart({
      entry: p37Child,
      daemonEnvironment: {
        ARBOR_P37_ROLE: "old",
        ARBOR_P37_PAUSE_ROLE: "old",
        ARBOR_P37_PAUSE_BOUNDARY:
          "AH10AfterControlHandlerReturnBeforeObservationCommit",
        ARBOR_P37_GATE_ACTION_KIND: "deliver",
      },
    });
    await client.command(seed.project.projectId, "SteerWork", {
      workId: seededWork.workId,
      workspaceId: producer.workspaceId,
      expectedWorkRevision: seededWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume the measured Deliver action ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });

    const beforeObservation = await awaitP37Probe(
      probes,
      (probe) =>
        probe.role === "old" &&
        probe.boundary ===
          "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
        probe.actionKind === "deliver",
    );
    const executionId = beforeObservation?.executionId;
    expect(executionId).toMatch(/^exe_/u);
    if (executionId === undefined)
      throw new Error("P37 old ExecutionId missing");

    const committedBeforeKill = readP37Snapshot(fixture.databaseFile);
    const receipt = committedBeforeKill.deliverMessageReceipts.filter(
      (row) => row.resolution === "Committed",
    );
    expect(receipt).toHaveLength(1);
    expect(committedBeforeKill.messages).toHaveLength(1);
    const originalMessageId = (
      committedBeforeKill.messages[0] as { message_id: string }
    ).message_id;
    expect(
      committedBeforeKill.messageEvents.filter(
        (event) => event.aggregate_ref === originalMessageId,
      ),
    ).toHaveLength(1);
    expect(committedBeforeKill.inbox).toHaveLength(1);
    expect(committedBeforeKill.actions).toHaveLength(1);
    const originalAction = committedBeforeKill.actions[0] as {
      execution_id: string;
      provider_turn_id: string;
      logical_action_id: string;
      call_ref: string;
      state: string;
    };
    expect(originalAction.execution_id).toBe(executionId);
    expect((receipt[0] as { command_id: string }).command_id).toBe(
      expectedDeliverCommandId(originalAction.provider_turn_id, 0),
    );
    expect(originalMessageId).toBe(
      expectedDeliverMessageId(originalAction.provider_turn_id),
    );
    expect(originalAction.state).not.toBe("Applied");
    expect(
      committedBeforeKill.observations.filter((observation) =>
        (observation as { source_ref?: string }).source_ref?.startsWith(
          `observation_${executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(seed.deliverDecisionCalls).toBe(1);

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: p37Child,
      daemonEnvironment: { ARBOR_P37_ROLE: "new" },
      onStdout: (line) => {
        try {
          const probe = JSON.parse(line) as P37Probe;
          if (probe.tag === "P37_DELIVER_PROBE") recordP37Probe(probes, probe);
        } catch {
          // The fixture retains stderr; unrelated stdout is not a P37 signal.
        }
      },
    });
    await fixture.crash();
    const newLease = await awaitP37Probe(
      probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "AH10AfterLeaseAcquired" &&
        probe.executionId === executionId,
    );
    expect(newLease?.fencingGeneration).toBe(1);

    const recovered = await waitForPublic(
      async () => readP37Snapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.actions.some(
          (action) =>
            (action as { logical_action_id?: string }).logical_action_id ===
              originalAction.logical_action_id &&
            (action as { state?: string }).state === "Applied",
        ) &&
        snapshot.actions.some((action) => {
          const observationSourceRef = (
            action as { observation_source_ref?: string | null }
          ).observation_source_ref;
          return (
            observationSourceRef !== undefined &&
            observationSourceRef !== null &&
            snapshot.observations.filter(
              (observation) =>
                (observation as { source_ref?: string }).source_ref ===
                observationSourceRef,
            ).length === 1
          );
        }),
      60_000,
    );
    const recoveredReceipt = recovered.deliverMessageReceipts.filter(
      (row) => row.resolution === "Committed",
    );
    expect(recoveredReceipt).toHaveLength(1);
    expect((recoveredReceipt[0] as { command_id: string }).command_id).toBe(
      (receipt[0] as { command_id: string }).command_id,
    );
    const receiptResult = JSON.parse(
      (recoveredReceipt[0] as { result_json: string }).result_json,
    ) as { messageId: string };
    expect(receiptResult.messageId).toBe(originalMessageId);
    expect(recovered.messages).toHaveLength(1);
    expect((recovered.messages[0] as { message_id: string }).message_id).toBe(
      originalMessageId,
    );
    expect(
      recovered.messageEvents.filter(
        (event) => event.aggregate_ref === originalMessageId,
      ),
    ).toHaveLength(1);
    expect(recovered.inbox).toHaveLength(1);
    expect(recovered.actions).toHaveLength(1);
    const recoveredAction = recovered.actions[0] as {
      observation_source_ref: string;
      provider_turn_id: string;
      logical_action_id: string;
    };
    expect(
      recovered.observations.filter(
        (observation) =>
          (observation as { source_ref: string }).source_ref ===
          recoveredAction.observation_source_ref,
      ),
    ).toHaveLength(1);
    expect(seed.deliverDecisionCalls).toBe(1);
    expect(recoveredAction.provider_turn_id).toBe(
      originalAction.provider_turn_id,
    );
    expect(recoveredAction.logical_action_id).toBe(
      originalAction.logical_action_id,
    );
    expect(newDaemon.daemonErrors).toEqual([]);
    await newDaemon.crash();
  }, 180_000);
  it("blocks a Committed receipt when a still-present Inbox row no longer matches", async () => {
    const marker = `P37-L6-INBOX-MISMATCH-${crypto.randomUUID().slice(0, 8)}`;
    const prepared = await deliverAndHoldCommittedReceipt(marker);
    await prepared.fixture.crash();
    const inboxDb = new DatabaseSync(prepared.fixture.databaseFile);
    try {
      const changed = inboxDb
        .prepare(
          "UPDATE inbox_entries SET summary = 'drifted before recovery' WHERE entry_key = ?",
        )
        .run(`msg:${prepared.message.message_id}`);
      expect(Number(changed.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    const initialOwnerController = {
      crash: prepared.fixture.crash,
      snapshot: prepared.fixture.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: prepared.fixture.databaseFile,
      executionId: prepared.action.execution_id,
      daemon: initialOwnerController,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: prepared.probes,
        executionId: prepared.action.execution_id,
        daemon: initialOwnerController,
      }),
    });
    const recovery = await startP37RecoveryDaemon(
      prepared.fixture,
      "new",
      prepared.probes,
      "AfterDeliverReplayAttentionCommit,P10AfterAttentionRowWriteBeforeConsumerCommit",
    );
    const failure = await awaitP37Probe(
      prepared.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "AfterDeliverReplayAttentionCommit" &&
        probe.logicalActionId === prepared.action.logical_action_id,
    );
    expect(failure?.failureCode).toBe("PriorReceiptResultMismatch");
    expect(failure?.messageId).toBe(prepared.message.message_id);
    const p9FactSnapshot = readP37Snapshot(prepared.fixture.databaseFile);
    const p9Fact = findDeliverReplayFact(
      p9FactSnapshot,
      prepared.action.logical_action_id,
      prepared.message.message_id,
    );
    if (p9Fact === undefined) {
      throw new Error(
        "P37 Inbox mismatch fact is absent after its commit probe",
      );
    }
    releaseP37Gate(
      prepared.fixture,
      "new",
      "boundary-AfterDeliverReplayAttentionCommit",
    );
    await awaitP37Probe(
      prepared.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "P10AfterAttentionRowWriteBeforeConsumerCommit" &&
        probe.attentionFactId === p9Fact.attention_fact_id,
    );
    const atFailure = readP37Snapshot(prepared.fixture.databaseFile);
    expect(atFailure.facts).toHaveLength(1);
    expect(atFailure.replayEvents).toHaveLength(1);
    expect(atFailure.deliverMessageReceipts).toHaveLength(1);
    expect(atFailure.messages).toHaveLength(1);
    expect(atFailure.messageEvents).toHaveLength(1);
    expect(atFailure.inbox).toHaveLength(1);
    expect((atFailure.inbox[0] as { summary: string }).summary).toBe(
      "drifted before recovery",
    );
    expect((atFailure.actions[0] as { state: string }).state).not.toBe(
      "Applied",
    );
    expect(
      atFailure.observations.filter(
        (row) =>
          (row as { source_ref: string }).source_ref ===
          prepared.action.observation_source_ref,
      ),
    ).toHaveLength(0);
    await recovery.crash();
    const recoveryOwnerController = {
      crash: recovery.crash,
      snapshot: recovery.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: prepared.fixture.databaseFile,
      executionId: prepared.action.execution_id,
      daemon: recoveryOwnerController,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: prepared.probes,
        executionId: prepared.action.execution_id,
        daemon: recoveryOwnerController,
      }),
    });
    await restartP37Normally(prepared.fixture);
    const finalWithFact = await waitForPublic(
      async () => readP37Snapshot(prepared.fixture.databaseFile),
      (snapshot) =>
        findDeliverReplayFact(
          snapshot,
          prepared.action.logical_action_id,
          prepared.message.message_id,
        ) !== undefined,
      60_000,
    );
    const stableFactId = findDeliverReplayFact(
      finalWithFact,
      prepared.action.logical_action_id,
      prepared.message.message_id,
    )?.attention_fact_id;
    expect(stableFactId).toBe(p9Fact.attention_fact_id);
    const attention = await waitForPublic(
      () =>
        publicDeliverReplayRows(prepared.client, prepared.project.projectId),
      (rows) => rows.length === 1 && rows[0]?.dedupKey === stableFactId,
      60_000,
    );
    expect(attention).toHaveLength(1);
    const final = readP37Snapshot(prepared.fixture.databaseFile);
    expect(final.facts).toHaveLength(1);
    expect(final.deliverMessageReceipts).toHaveLength(1);
    expect(final.messages).toHaveLength(1);
    expect(final.messageEvents).toHaveLength(1);
    expect(final.inbox).toHaveLength(1);
    expect((final.actions[0] as { state: string }).state).not.toBe("Applied");
    expect(prepared.deliverDecisionCalls).toBe(1);
  }, 240_000);

  it("converges an exact Committed receipt when its Inbox row was consumed or cleaned up", async () => {
    const marker = `P37-L6-INBOX-ABSENT-${crypto.randomUUID().slice(0, 8)}`;
    const prepared = await deliverAndHoldCommittedReceipt(marker);
    const before = readP37Snapshot(prepared.fixture.databaseFile);
    expect(before.deliverMessageReceipts).toHaveLength(1);
    expect(before.messages).toHaveLength(1);
    expect(before.messageEvents).toHaveLength(1);
    expect(before.inbox).toHaveLength(1);
    await prepared.fixture.crash();
    const inboxDb = new DatabaseSync(prepared.fixture.databaseFile);
    try {
      const deleted = inboxDb
        .prepare("DELETE FROM inbox_entries WHERE entry_key = ?")
        .run(`msg:${prepared.message.message_id}`);
      expect(Number(deleted.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    const leaseOwnerController = {
      crash: prepared.fixture.crash,
      snapshot: prepared.fixture.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: prepared.fixture.databaseFile,
      executionId: prepared.action.execution_id,
      daemon: leaseOwnerController,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: prepared.probes,
        executionId: prepared.action.execution_id,
        daemon: leaseOwnerController,
      }),
    });
    const recovery = await startP37RecoveryDaemon(
      prepared.fixture,
      "new",
      prepared.probes,
    );
    const converged = await waitForPublic(
      async () => readP37Snapshot(prepared.fixture.databaseFile),
      (snapshot) =>
        snapshot.actions.some(
          (action) =>
            (action as { logical_action_id: string }).logical_action_id ===
              prepared.action.logical_action_id &&
            (action as { state: string }).state === "Applied",
        ),
      60_000,
    );
    expect(converged.deliverMessageReceipts).toHaveLength(1);
    expect(
      (
        converged.deliverMessageReceipts[0] as {
          command_id: string;
        }
      ).command_id,
    ).toBe(prepared.receipt.command_id);
    expect((converged.messages[0] as { message_id: string }).message_id).toBe(
      prepared.message.message_id,
    );
    expect(converged.messageEvents).toHaveLength(1);
    expect(converged.inbox).toHaveLength(0);
    expect(converged.facts).toHaveLength(0);
    expect(converged.replayEvents).toHaveLength(0);
    const applied = converged.actions[0] as {
      execution_id: string;
      provider_turn_id: string;
      logical_action_id: string;
      observation_source_ref: string;
    };
    expect(applied.execution_id).toBe(prepared.action.execution_id);
    expect(applied.provider_turn_id).toBe(prepared.action.provider_turn_id);
    expect(applied.logical_action_id).toBe(prepared.action.logical_action_id);
    expect(
      converged.observations.filter(
        (row) =>
          (row as { source_ref: string }).source_ref ===
          applied.observation_source_ref,
      ),
    ).toHaveLength(1);
    expect(prepared.deliverDecisionCalls).toBe(1);
    expect(recovery.daemonErrors).toEqual([]);
    await recovery.crash();
  }, 240_000);
  it.each(["before", "after"] as const)(
    "kills %s the P9 DeliverReplay event/fact/outbox commit and retains one public Attention after restart",
    async (crashSide) => {
      const marker = `P37-L6-P9-${crashSide}-${crypto.randomUUID().slice(0, 8)}`;
      const prepared = await prepareContradictoryCommittedReceipt(marker);
      const recovery = await startP37RecoveryDaemon(
        prepared.fixture,
        "new",
        prepared.probes,
        crashSide === "before"
          ? "BeforeDeliverReplayAttentionCommit"
          : "AfterDeliverReplayAttentionCommit,P10AfterAttentionRowWriteBeforeConsumerCommit",
      );
      const boundary =
        crashSide === "before"
          ? "BeforeDeliverReplayAttentionCommit"
          : "AfterDeliverReplayAttentionCommit";
      const p9Probe = await awaitP37Probe(
        prepared.probes,
        (probe) => probe.role === "new" && probe.boundary === boundary,
      );
      expect(p9Probe?.logicalActionId).toBe(prepared.action.logical_action_id);
      expect(p9Probe?.messageId).toBe(prepared.message.message_id);
      let atBoundary = readP37Snapshot(prepared.fixture.databaseFile);
      let attentionFactId = findDeliverReplayFact(
        atBoundary,
        prepared.action.logical_action_id,
        prepared.message.message_id,
      )?.attention_fact_id;
      if (crashSide === "before") {
        expect(atBoundary.facts).toHaveLength(0);
        expect(atBoundary.replayEvents).toHaveLength(0);
        expect(atBoundary.pendingFacts).toHaveLength(0);
      } else {
        expect(attentionFactId).toBeDefined();
        expect(atBoundary.facts).toHaveLength(1);
        expect(atBoundary.replayEvents).toHaveLength(1);
        expect(atBoundary.pendingFacts).toHaveLength(1);
        expect(atBoundary.markers).toHaveLength(0);
        releaseP37Gate(
          prepared.fixture,
          "new",
          "boundary-AfterDeliverReplayAttentionCommit",
        );
        await awaitP37Probe(
          prepared.probes,
          (probe) =>
            probe.role === "new" &&
            probe.boundary ===
              "P10AfterAttentionRowWriteBeforeConsumerCommit" &&
            probe.attentionFactId === attentionFactId,
        );
        atBoundary = readP37Snapshot(prepared.fixture.databaseFile);
        expect(atBoundary.facts).toHaveLength(1);
        expect(atBoundary.replayEvents).toHaveLength(1);
        expect(atBoundary.pendingFacts).toHaveLength(1);
        expect(atBoundary.markers).toHaveLength(0);
      }
      await recovery.crash();
      if (p9Probe?.executionId !== undefined) {
        const expiredOwnerDaemon = {
          crash: recovery.crash,
          snapshot: recovery.daemonProcessSnapshot,
        };
        await expireP37LeaseForQualification({
          databaseFile: prepared.fixture.databaseFile,
          executionId: p9Probe.executionId,
          daemon: expiredOwnerDaemon,
          ownerEvidence: p37LeaseOwnerEvidence({
            probes: prepared.probes,
            executionId: p9Probe.executionId,
            daemon: expiredOwnerDaemon,
          }),
        });
      }
      await restartP37Normally(prepared.fixture);
      const finalWithFact = await waitForPublic(
        async () => readP37Snapshot(prepared.fixture.databaseFile),
        (snapshot) =>
          findDeliverReplayFact(
            snapshot,
            prepared.action.logical_action_id,
            prepared.message.message_id,
          ) !== undefined,
        60_000,
      );
      attentionFactId = findDeliverReplayFact(
        finalWithFact,
        prepared.action.logical_action_id,
        prepared.message.message_id,
      )?.attention_fact_id;
      expect(attentionFactId).toBeDefined();
      const attentionRows = await waitForPublic(
        () =>
          publicDeliverReplayRows(prepared.client, prepared.project.projectId),
        (rows) => rows.some((row) => row.dedupKey === attentionFactId),
        60_000,
      );
      const exactRows = attentionRows.filter(
        (row) => row.dedupKey === attentionFactId,
      );
      expect(exactRows).toHaveLength(1);
      expect(exactRows[0]).toMatchObject({
        source: "DeliverReplayFailure",
        severity: "ActionRequired",
        targetWorkspaceId: prepared.producer.workspaceId,
        dedupKey: attentionFactId,
        summaryRef:
          "A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.",
      });
      const final = readP37Snapshot(prepared.fixture.databaseFile);
      expect(final.facts).toHaveLength(1);
      expect(final.replayEvents).toHaveLength(1);
      expect(final.messages).toHaveLength(1);
      expect(final.messageEvents).toHaveLength(1);
      expect(final.inbox).toHaveLength(1);
      expect(final.actions).toHaveLength(1);
      expect((final.actions[0] as { state: string }).state).not.toBe("Applied");
      expect(prepared.deliverDecisionCalls).toBe(1);
    },
    240_000,
  );
  it("does not accept a gen0 direct-write Observation in gen1; an existing fact still blocks after Inbox deletion", async () => {
    const marker = `P37-L6-LEGACY-GEN0-${crypto.randomUUID().slice(0, 8)}`;
    const seed = await seedDeliverableWaitingForDelivery(marker);
    seed.armDeliver();
    await seed.fixture.crash();
    await seed.fixture.restart({
      entry: p37Child,
      daemonEnvironment: {
        ARBOR_P37_ROLE: "old",
        ARBOR_P37_PAUSE_ROLE: "old",
        ARBOR_P37_PAUSE_BOUNDARY: "AH7AfterActionIntentCommit",
        ARBOR_P37_GATE_ACTION_KIND: "deliver",
        ARBOR_P37_LEGACY_DIRECT_ROLE: "old",
        ARBOR_P37_LEGACY_DELIVERABLE_ID: String(
          seed.deliverable.deliverable_id,
        ),
        ARBOR_P37_LEGACY_SUMMARY: `Delivered ${marker}`,
      },
    });
    await seed.client.command(seed.project.projectId, "SteerWork", {
      workId: seed.seededWork.workId,
      workspaceId: seed.producer.workspaceId,
      expectedWorkRevision: seed.seededWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume the measured Deliver action ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const oldAction = await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "old" &&
        probe.boundary === "P37LegacyDirectObservationReturned" &&
        probe.actionKind === "deliver",
    );
    if (
      oldAction?.executionId === undefined ||
      oldAction.providerTurnId === undefined ||
      oldAction.logicalActionId === undefined ||
      oldAction.callRef === undefined ||
      oldAction.legacyObservationText === undefined
    ) {
      throw new Error("P37 gen0 direct-write action identity is incomplete");
    }
    expect(oldAction.legacyObservationText).toContain(
      `DeliverableDelivered(${seed.deliverable.deliverable_id}, `,
    );
    const executionId = oldAction.executionId;
    const providerTurnId = oldAction.providerTurnId;
    const logicalActionId = oldAction.logicalActionId;
    const directWrite = readP37Snapshot(seed.fixture.databaseFile);
    expect(directWrite.deliverMessageReceipts).toHaveLength(0);
    expect(directWrite.messages).toHaveLength(1);
    expect(directWrite.messageEvents).toHaveLength(1);
    expect(directWrite.inbox).toHaveLength(1);
    expect(directWrite.actions).toHaveLength(1);
    expect((directWrite.actions[0] as { state: string }).state).not.toBe(
      "Applied",
    );
    await seed.fixture.crash();
    const initialOwnerController = {
      crash: seed.fixture.crash,
      snapshot: seed.fixture.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: seed.fixture.databaseFile,
      executionId,
      daemon: initialOwnerController,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: seed.probes,
        executionId,
        daemon: initialOwnerController,
      }),
    });

    const recovery = await startP37RecoveryDaemon(
      seed.fixture,
      "new",
      seed.probes,
      "AfterDeliverReplayAttentionCommit,P10AfterAttentionRowWriteBeforeConsumerCommit",
    );
    const failure = await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "AfterDeliverReplayAttentionCommit" &&
        probe.logicalActionId === logicalActionId,
    );
    expect(failure?.failureCode).toBe("PriorReceiptEffectConflict");
    expect(failure?.messageId).toBe(expectedDeliverMessageId(providerTurnId));
    const p9FactSnapshot = readP37Snapshot(seed.fixture.databaseFile);
    const p9Fact = findDeliverReplayFact(
      p9FactSnapshot,
      logicalActionId,
      expectedDeliverMessageId(providerTurnId),
    );
    if (p9Fact === undefined) {
      throw new Error("P37 P9 post-commit probe has no committed fact row");
    }
    releaseP37Gate(
      seed.fixture,
      "new",
      "boundary-AfterDeliverReplayAttentionCommit",
    );
    await awaitP37Probe(
      seed.probes,
      (probe) =>
        probe.role === "new" &&
        probe.boundary === "P10AfterAttentionRowWriteBeforeConsumerCommit" &&
        probe.attentionFactId === p9Fact.attention_fact_id,
    );
    const failureCommitted = readP37Snapshot(seed.fixture.databaseFile);
    expect(failureCommitted.facts).toHaveLength(1);
    expect(failureCommitted.replayEvents).toHaveLength(1);
    expect(failureCommitted.deliverMessageReceipts).toHaveLength(0);
    expect(failureCommitted.messages).toHaveLength(1);
    expect(failureCommitted.messageEvents).toHaveLength(1);
    expect(failureCommitted.pendingFacts).toHaveLength(1);
    expect(failureCommitted.markers).toHaveLength(0);
    await recovery.crash();

    const inboxDb = new DatabaseSync(seed.fixture.databaseFile);
    try {
      const deleted = inboxDb
        .prepare("DELETE FROM inbox_entries WHERE entry_key = ?")
        .run(`msg:${expectedDeliverMessageId(providerTurnId)}`);
      expect(Number(deleted.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    const recoveryOwnerController = {
      crash: recovery.crash,
      snapshot: recovery.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: seed.fixture.databaseFile,
      executionId,
      daemon: recoveryOwnerController,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: seed.probes,
        executionId,
        daemon: recoveryOwnerController,
      }),
    });
    await restartP37Normally(seed.fixture);
    const finalWithFact = await waitForPublic(
      async () => readP37Snapshot(seed.fixture.databaseFile),
      (snapshot) =>
        findDeliverReplayFact(
          snapshot,
          logicalActionId,
          expectedDeliverMessageId(providerTurnId),
        ) !== undefined,
      60_000,
    );
    const stableFactId = findDeliverReplayFact(
      finalWithFact,
      logicalActionId,
      expectedDeliverMessageId(providerTurnId),
    )?.attention_fact_id;
    expect(stableFactId).toBe(p9Fact.attention_fact_id);
    const attentionRows = await waitForPublic(
      () => publicDeliverReplayRows(seed.client, seed.project.projectId),
      (rows) => rows.length === 1 && rows[0]?.dedupKey === stableFactId,
      60_000,
    );
    expect(attentionRows).toHaveLength(1);
    expect(attentionRows[0]).toMatchObject({
      severity: "ActionRequired",
      dedupKey: stableFactId,
    });
    const final = readP37Snapshot(seed.fixture.databaseFile);
    expect(final.facts).toHaveLength(1);
    expect(final.replayEvents).toHaveLength(1);
    expect(final.messages).toHaveLength(1);
    expect(final.messageEvents).toHaveLength(1);
    expect(final.inbox).toHaveLength(0);
    expect(final.deliverMessageReceipts).toHaveLength(0);
    expect((final.actions[0] as { state: string }).state).not.toBe("Applied");
    expect(seed.deliverDecisionCalls).toBe(1);
  }, 240_000);
  it.each(["before", "after"] as const)(
    "kills %s the P10 DeliverReplay marker/ACK/offset commit and keeps one public row",
    async (crashSide) => {
      const marker = `P37-L6-P10-${crashSide}-${crypto.randomUUID().slice(0, 8)}`;
      const prepared = await prepareContradictoryCommittedReceipt(marker);
      const before = readP37Snapshot(prepared.fixture.databaseFile);
      const initialOffset = Number(
        (
          before.attentionOffsets.find(
            (row) =>
              (row as { project_id: string }).project_id ===
              prepared.project.projectId,
          ) as { last_sequence?: number } | undefined
        )?.last_sequence ?? 0,
      );
      const boundary =
        crashSide === "before"
          ? "P10AfterAttentionRowWriteBeforeConsumerCommit"
          : "P10AfterDeliverAttentionConsumerCommit";
      const recovery = await startP37RecoveryDaemon(
        prepared.fixture,
        "new",
        prepared.probes,
        boundary,
      );
      const projectionProbe = await awaitP37Probe(
        prepared.probes,
        (probe) =>
          probe.role === "new" &&
          probe.boundary === boundary &&
          probe.projectId === prepared.project.projectId,
      );
      expect(projectionProbe?.attentionFactId).toBeTruthy();
      const atBoundary = readP37Snapshot(prepared.fixture.databaseFile);
      const projectOffset = atBoundary.attentionOffsets.find(
        (row) =>
          (row as { project_id: string }).project_id ===
          prepared.project.projectId,
      ) as { last_sequence?: number } | undefined;
      const offsetAtPreCommit = Number(projectOffset?.last_sequence ?? 0);
      expect(offsetAtPreCommit).toBeGreaterThanOrEqual(initialOffset);
      if (crashSide === "before") {
        expect(
          atBoundary.markers.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(0);
        expect(
          atBoundary.pendingFacts.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(1);
      } else {
        expect(
          atBoundary.markers.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(1);
        expect(
          atBoundary.pendingFacts.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(0);
        expect(Number(projectOffset?.last_sequence ?? 0)).toBeGreaterThan(
          initialOffset,
        );
      }
      await recovery.crash();
      if (crashSide === "before") {
        const afterPreCommitCrash = readP37Snapshot(
          prepared.fixture.databaseFile,
        );
        const offsetAfterCrash = afterPreCommitCrash.attentionOffsets.find(
          (row) =>
            (row as { project_id: string }).project_id ===
            prepared.project.projectId,
        ) as { last_sequence?: number } | undefined;
        expect(
          afterPreCommitCrash.markers.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(0);
        expect(
          afterPreCommitCrash.pendingFacts.filter(
            (row) =>
              (row as { attention_fact_id: string }).attention_fact_id ===
              projectionProbe?.attentionFactId,
          ),
        ).toHaveLength(1);
        expect(Number(offsetAfterCrash?.last_sequence ?? 0)).toBe(
          offsetAtPreCommit,
        );
      }
      if (projectionProbe?.executionId !== undefined) {
        const expiredOwnerDaemon = {
          crash: recovery.crash,
          snapshot: recovery.daemonProcessSnapshot,
        };
        await expireP37LeaseForQualification({
          databaseFile: prepared.fixture.databaseFile,
          executionId: projectionProbe.executionId,
          daemon: expiredOwnerDaemon,
          ownerEvidence: p37LeaseOwnerEvidence({
            probes: prepared.probes,
            executionId: projectionProbe.executionId,
            daemon: expiredOwnerDaemon,
          }),
        });
      }
      await restartP37Normally(prepared.fixture);
      const publicRows = await waitForPublic(
        () =>
          publicDeliverReplayRows(prepared.client, prepared.project.projectId),
        (rows) =>
          rows.some((row) => row.dedupKey === projectionProbe?.attentionFactId),
        60_000,
      );
      expect(
        publicRows.filter(
          (row) => row.dedupKey === projectionProbe?.attentionFactId,
        ),
      ).toHaveLength(1);
      const final = readP37Snapshot(prepared.fixture.databaseFile);
      expect(
        final.markers.filter(
          (row) =>
            (row as { attention_fact_id: string }).attention_fact_id ===
            projectionProbe?.attentionFactId,
        ),
      ).toHaveLength(1);
      expect(prepared.deliverDecisionCalls).toBe(1);
    },
    240_000,
  );
  it("keeps an existing P9 fact ActionRequired after Inbox evidence drifts, without a new Command or Observation", async () => {
    const marker = `P37-L6-CONFLICT-${crypto.randomUUID().slice(0, 8)}`;
    const prepared = await prepareContradictoryCommittedReceipt(marker);
    const recovery = await startP37RecoveryDaemon(
      prepared.fixture,
      "new",
      prepared.probes,
    );
    const initialAttention = await waitForPublic(
      () =>
        publicDeliverReplayRows(
          makePublicClient(recovery.baseUrl),
          prepared.project.projectId,
        ),
      (rows) => rows.length === 1,
      60_000,
    );
    const originalFactId = initialAttention[0]?.dedupKey;
    expect(originalFactId).toBeTruthy();
    const beforeDrift = readP37Snapshot(prepared.fixture.databaseFile);
    expect(beforeDrift.facts).toHaveLength(1);
    const deliverCommandCount = beforeDrift.deliverMessageReceipts.length;
    const inboxDb = new DatabaseSync(prepared.fixture.databaseFile);
    try {
      const changed = inboxDb
        .prepare(
          "UPDATE inbox_entries SET summary = 'drifted after fact commit' WHERE entry_key = ?",
        )
        .run(`msg:${prepared.message.message_id}`);
      expect(Number(changed.changes)).toBe(1);
    } finally {
      inboxDb.close();
    }
    await recovery.crash();
    if (prepared.held.executionId === undefined) {
      throw new Error("P37 contradictory receipt ExecutionId missing");
    }
    const expiredOwnerDaemon = {
      crash: recovery.crash,
      snapshot: recovery.daemonProcessSnapshot,
    };
    await expireP37LeaseForQualification({
      databaseFile: prepared.fixture.databaseFile,
      executionId: prepared.held.executionId,
      daemon: expiredOwnerDaemon,
      ownerEvidence: p37LeaseOwnerEvidence({
        probes: prepared.probes,
        executionId: prepared.held.executionId,
        daemon: expiredOwnerDaemon,
      }),
    });
    await restartP37Normally(prepared.fixture);
    const attentionRows = await waitForPublic(
      () =>
        publicDeliverReplayRows(prepared.client, prepared.project.projectId),
      (rows) => rows.length === 1 && rows[0]?.dedupKey === originalFactId,
      60_000,
    );
    expect(attentionRows).toHaveLength(1);
    const final = readP37Snapshot(prepared.fixture.databaseFile);
    expect(final.facts).toHaveLength(1);
    expect(final.messages).toHaveLength(1);
    expect(final.messageEvents).toHaveLength(1);
    expect(final.inbox).toHaveLength(1);
    const action = final.actions[0] as {
      state: string;
      observation_source_ref: string | null;
    };
    expect(action.state).not.toBe("Applied");
    expect(action.observation_source_ref).toBeNull();
    expect(final.deliverMessageReceipts).toHaveLength(deliverCommandCount);
    expect((final.inbox[0] as { summary: string }).summary).toBe(
      "drifted after fact commit",
    );
    expect(prepared.deliverDecisionCalls).toBe(1);
  }, 180_000);
});
