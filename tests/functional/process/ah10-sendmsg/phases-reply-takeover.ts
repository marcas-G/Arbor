import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import {
  expireExecutionLeaseAfterOwnerExitForQualification,
  waitForLiveOwnerLeaseExpiryForQualification,
} from "../../support/lease-qualification.js";
import { waitForPublic } from "../../support/public-client.js";
import {
  type Ah10ReplyScenarioState,
  ah10Child,
  fencedReceipts,
  pushProbe,
  readRows,
  releaseGate,
} from "./support.js";

export const ah10SendMsgReplyTakeover = async (
  s: Ah10ReplyScenarioState,
): Promise<void> => {
  const fixture = s.fixture!;
  const query = s.query!;
  const oldAction = s.oldAction!;
  const providerTurnId = s.providerTurnId!;
  const logicalActionId = s.logicalActionId!;
  const callRef = s.callRef!;
  const {
    crashSide,
    events,
    replyProviderCalls,
    childWorkspaceId,
    parentWorkspaceId,
    oldLeaseAtIntent,
  } = s;
  let newDaemon: typeof s.newDaemon = s.newDaemon;
  let oldRejectedCommandId: string | undefined = s.oldRejectedCommandId;
  let beforeCrash = s.beforeCrash!;
  const setNewDaemon = (daemon: NonNullable<typeof newDaemon> | undefined) => {
    newDaemon = daemon;
    s.newDaemon = daemon;
  };
  const setOldRejectedCommandId = (commandId: string | undefined) => {
    oldRejectedCommandId = commandId;
    s.oldRejectedCommandId = commandId;
  };
  const setBeforeCrash = (rows: NonNullable<typeof beforeCrash>) => {
    beforeCrash = rows;
    s.beforeCrash = rows;
  };
  if (crashSide === "committed") {
    releaseGate(fixture, "old", "action-intent");
    const handlerReturned = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.callRef === callRef &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      15_000,
    );
    if (handlerReturned === undefined)
      throw new Error("AH10 post-Reply handler probe was absent");
    setBeforeCrash(readRows(fixture.databaseFile));
    const committedReply = beforeCrash.messages.find(
      (message) =>
        message.kind === "Reply" &&
        message.sender_workspace_id === parentWorkspaceId &&
        message.recipient_workspace_id === childWorkspaceId,
    );
    expect(committedReply).toBeDefined();
    expect(committedReply?.correlation_id).toBe(query.correlation_id);
    expect(beforeCrash.messages).toHaveLength(2);
    expect(
      beforeCrash.correlations.filter(
        (row) =>
          row.correlation_id === query.correlation_id && row.closed_at !== null,
      ),
    ).toHaveLength(1);
    expect(
      beforeCrash.messageEvents.filter(
        (row) => row.aggregate_ref === committedReply?.message_id,
      ),
    ).toHaveLength(1);
    expect(beforeCrash.inbox).toHaveLength(2);
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: providerTurnId,
        logical_action_id: logicalActionId,
        call_ref: callRef,
        action_kind: "send_message",
        state: "Pending",
        observation_source_ref: null,
      }),
    );
    expect(
      beforeCrash.observations.filter((row) =>
        row.source_ref.startsWith(`observation_${oldAction.executionId}_`),
      ),
    ).toHaveLength(0);
    expect(
      beforeCrash.providerAttempts.filter(
        (row) => row.provider_turn_id === providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success", attempt_no: 0 })]);
    expect(replyProviderCalls).toHaveLength(1);
    await fixture.crash();
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldAction.executionId,
      daemon: {
        crash: fixture.crash,
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
  } else {
    writeFileSync(
      resolve(fixture.directory, "ah10-gates", "old-lease-renewal.pause"),
      "pause next renewal",
    );
    const oldLeasePause = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeLeaseRenewal" &&
            event.executionId === oldAction.executionId &&
            event.pauseRequested === true,
        ),
      (event) => event !== undefined,
      20_000,
    );
    if (oldLeasePause === undefined)
      throw new Error("AH10 old Reply lease renewal pause probe was absent");
    expect(oldLeasePause.fencingGeneration).toBe(0);
    await waitForLiveOwnerLeaseExpiryForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldAction.executionId,
      pauseEvidence: {
        boundary: "AH10BeforeLeaseRenewal",
        pauseRequested: oldLeasePause.pauseRequested === true,
        executionId: oldLeasePause.executionId,
        fencingGeneration: oldLeasePause.fencingGeneration ?? -1,
      },
      expected: {
        generation: 0,
        ...(oldLeaseAtIntent === undefined
          ? {}
          : { expiresAt: oldLeaseAtIntent.expires_at }),
      },
      daemon: {
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
    setNewDaemon(
      await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_GATE_ACTION_KIND: "send_message",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        },
        onStdout: (line) => pushProbe(events, line),
      }),
    );
    const newLeaseProbe = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(newLeaseProbe?.fencingGeneration).toBe(1);
    const newIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "send_message" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(newIntent?.providerTurnId).toBe(providerTurnId);
    expect(newIntent?.logicalActionId).toBe(logicalActionId);
    expect(newIntent?.callRef).toBe(callRef);
    releaseGate(fixture, "old", "action-intent");
    if (crashSide === "before") {
      const precommit = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeFencedReceiptCommit" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        15_000,
      );
      expect(precommit?.commandId).toMatch(/^cmd_/u);
      setOldRejectedCommandId(precommit?.commandId);
      const independentRead = readRows(fixture.databaseFile);
      expect(fencedReceipts(independentRead)).toHaveLength(0);
      expect(independentRead.messages).toEqual([query]);
      expect(independentRead.messageEvents).toHaveLength(1);
      expect(independentRead.inbox).toHaveLength(1);
    } else {
      const rejected = await waitForPublic(
        async () => fencedReceipts(readRows(fixture.databaseFile)),
        (rows) => rows.length === 1,
        15_000,
      );
      setOldRejectedCommandId(rejected[0]?.command_id);
      expect(oldRejectedCommandId).toMatch(/^cmd_/u);
    }
    await fixture.crash();
    setBeforeCrash(readRows(fixture.databaseFile));
    expect(fencedReceipts(beforeCrash)).toHaveLength(
      crashSide === "before" ? 0 : 1,
    );
    if (crashSide === "before") {
      expect(
        beforeCrash.commands.some(
          (row) => row.command_id === oldRejectedCommandId,
        ),
      ).toBe(false);
    }
    expect(beforeCrash.messages).toEqual([query]);
    expect(beforeCrash.messageEvents).toHaveLength(1);
    expect(beforeCrash.inbox).toHaveLength(1);
    expect(
      beforeCrash.correlations.filter(
        (row) =>
          row.correlation_id === query.correlation_id && row.closed_at !== null,
      ),
    ).toHaveLength(0);
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: providerTurnId,
        logical_action_id: logicalActionId,
        call_ref: callRef,
        action_kind: "send_message",
        state: "Pending",
        observation_source_ref: null,
      }),
    );
    expect(
      beforeCrash.observations.filter((row) =>
        row.source_ref.startsWith(`observation_${oldAction.executionId}_`),
      ),
    ).toHaveLength(0);
    expect(replyProviderCalls).toHaveLength(1);
  }
  if (newDaemon === undefined) {
    newDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "send_message",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    setNewDaemon(newDaemon);
  }
  const newLease = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === oldAction.executionId,
      ),
    (event) => event !== undefined,
    45_000,
  );
  if (newLease === undefined) {
    throw new Error("AH10 new Reply owner did not acquire the lease");
  }
  expect(newLease.fencingGeneration).toBe(1);
  const newAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionKind === "send_message" &&
          event.executionId === oldAction.executionId &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  if (newAction === undefined) {
    throw new Error("AH10 new Reply ActionIntent probe was absent");
  }
  expect(newAction.providerTurnId).toBe(providerTurnId);
  expect(newAction.callRef).toBe(callRef);
  expect(newAction.logicalActionId).toBe(logicalActionId);
  releaseGate(fixture, "new", "action-intent");
  const recovered = await waitForPublic(
    async () => readRows(fixture.databaseFile),
    (rows) =>
      rows.actions.some(
        (action) =>
          action.execution_id === oldAction.executionId &&
          action.logical_action_id === logicalActionId &&
          action.state === "Applied",
      ),
    30_000,
  );
  const recoveredReply = recovered.messages.filter(
    (message) =>
      message.kind === "Reply" &&
      message.sender_workspace_id === parentWorkspaceId &&
      message.recipient_workspace_id === childWorkspaceId,
  );
  expect(recovered.messages).toHaveLength(2);
  expect(recoveredReply).toHaveLength(1);
  const reply = recoveredReply[0];
  expect(reply?.correlation_id).toBe(query.correlation_id);
  expect(recovered.inbox).toHaveLength(2);
  expect(recovered.messageEvents).toHaveLength(2);
  const replyEvents = recovered.messageEvents.filter(
    (event) => event.aggregate_ref === reply?.message_id,
  );
  expect(replyEvents).toHaveLength(1);
  expect(replyEvents[0]).toMatchObject({
    event_type: "MessageSent",
    correlation_ref: query.correlation_id,
  });
  expect(
    recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      try {
        return (
          (JSON.parse(command.result_json) as { messageId?: string })
            .messageId === reply?.message_id
        );
      } catch {
        return false;
      }
    }),
  ).toHaveLength(1);
  const committedReplyReceipt = recovered.commands.find(
    (command) =>
      command.resolution === "Committed" &&
      command.result_json !== null &&
      (JSON.parse(command.result_json) as { messageId?: string }).messageId ===
        reply?.message_id,
  );
  expect(replyEvents[0]?.caused_by_command_id).toBe(
    committedReplyReceipt?.command_id,
  );
  if (crashSide === "committed") {
    expect(
      beforeCrash.commands.find(
        (command) => command.command_id === committedReplyReceipt?.command_id,
      ),
    ).toMatchObject({ resolution: "Committed" });
  } else {
    expect(committedReplyReceipt?.command_id).not.toBe(oldRejectedCommandId);
    expect(fencedReceipts(recovered)).toHaveLength(
      crashSide === "before" ? 0 : 1,
    );
  }
  expect(
    recovered.correlations.filter(
      (correlation) =>
        correlation.correlation_id === query.correlation_id &&
        correlation.closed_at !== null,
    ),
  ).toHaveLength(1);
  const recoveredReplyAction = recovered.actions.find(
    (action) =>
      action.execution_id === oldAction.executionId &&
      action.logical_action_id === logicalActionId,
  );
  expect(recoveredReplyAction).toMatchObject({
    provider_turn_id: providerTurnId,
    call_ref: callRef,
    action_kind: "send_message",
    state: "Applied",
  });
  expect(
    recovered.observations.filter(
      (observation) =>
        observation.source_ref === recoveredReplyAction?.observation_source_ref,
    ),
  ).toHaveLength(1);
  expect(
    recovered.providerAttempts.filter(
      (attempt) => attempt.provider_turn_id === providerTurnId,
    ),
  ).toEqual([expect.objectContaining({ outcome: "Success", attempt_no: 0 })]);
  expect(replyProviderCalls).toHaveLength(1);
  expect(newDaemon.daemonErrors).toEqual([]);
};
