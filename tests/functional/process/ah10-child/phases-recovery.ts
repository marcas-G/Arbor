import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  createP32MigrationBaseline,
  upgradeSchema44TestDatabase,
  upgradeSchema44ToCurrentTestDatabase,
} from "../../../support/schema44-database.js";
import {
  expireExecutionLeaseAfterOwnerExitForQualification,
  waitForLiveOwnerLeaseExpiryForQualification,
} from "../../support/lease-qualification.js";
import { waitForPublic } from "../../support/public-client.js";
import {
  type Ah10ScenarioState,
  ah10Child,
  pushProbe,
  releaseGate,
} from "./support.js";
import {
  makePreBindingP32Copy,
  schemaSnapshot,
} from "./support-legacy-image.js";
import { fencedReceipts, readRows, targetWorks } from "./support-rows.js";

export const ah10PhaseLeaseQualification = async (
  s: Ah10ScenarioState,
): Promise<void> => {
  const { crashSide, events, targetObjective, priorCommittedCommandId } = s;
  const fixture = s.fixture!;
  const oldAction = s.oldAction!;
  const logicalActionId = s.logicalActionId!;
  const callRef = s.callRef!;
  const liveOwnerPauseEvidence = s.liveOwnerPauseEvidence;
  const oldLeaseOwnerWorkerId = s.oldLeaseOwnerWorkerId;
  const oldLeaseOwnerIncarnationId = s.oldLeaseOwnerIncarnationId;
  const assignWorkAuthorizedPause = s.assignWorkAuthorizedPause;
  if (crashSide === "approval-fencing-before") {
    if (liveOwnerPauseEvidence === undefined) {
      throw new Error(`live-owner branch ${crashSide} omitted pause evidence`);
    }
    if (
      oldLeaseOwnerWorkerId === undefined ||
      oldLeaseOwnerIncarnationId === undefined
    ) {
      throw new Error(
        `live-owner branch ${crashSide} omitted exact lease identity`,
      );
    }
    const exactOldLeaseOwner = {
      workerId: oldLeaseOwnerWorkerId,
      workerIncarnationId: oldLeaseOwnerIncarnationId,
    };
    const assertApprovalFencingBeforeCommandBlocked = () => {
      const currentRows = readRows(s.recoveryDatabaseFile);
      const liveLease = currentRows.leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      );
      expect(liveLease).toMatchObject({
        execution_id: oldAction.executionId,
        worker_id: exactOldLeaseOwner.workerId,
        worker_incarnation_id: exactOldLeaseOwner.workerIncarnationId,
        generation: 1,
      });
      expect(
        existsSync(
          resolve(
            fixture.directory,
            "ah10-gates",
            "old-assign-work-authorized.release",
          ),
        ),
      ).toBe(false);
      expect(
        existsSync(
          resolve(fixture.directory, "ah10-gates", "old-lease-renewal.release"),
        ),
      ).toBe(false);
      expect(
        events.filter(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterAssignWorkAuthorizedBeforeCommandSubmission" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.callRef === callRef,
        ),
      ).toEqual([assignWorkAuthorizedPause]);
      expect(
        events.some(
          (event) =>
            event.role === "old" &&
            (event.boundary === "AH10BeforeFencedReceiptCommit" ||
              event.boundary ===
                "AH10AfterControlHandlerReturnBeforeObservationCommit") &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.callRef === callRef,
        ),
      ).toBe(false);
      expect(
        currentRows.assignWorkTargetBindings.filter(
          (binding) =>
            binding.execution_id === oldAction.executionId &&
            binding.logical_action_id === logicalActionId &&
            binding.call_ref === callRef,
        ),
      ).toEqual([]);
      expect(
        currentRows.controlResults.filter((result) => {
          try {
            const payload = JSON.parse(result.payload_json) as {
              callRef?: string;
              actionKind?: string;
            };
            return (
              payload.callRef === callRef &&
              payload.actionKind === "assign_work"
            );
          } catch {
            return false;
          }
        }),
      ).toEqual([]);
      expect(targetWorks(currentRows, targetObjective)).toHaveLength(0);
    };
    assertApprovalFencingBeforeCommandBlocked();
    const liveLeaseBeforeQualification = readRows(
      s.recoveryDatabaseFile,
    ).leases.find((lease) => lease.execution_id === oldAction.executionId);
    if (liveLeaseBeforeQualification === undefined) {
      throw new Error(
        "AssignWork live lease tuple absent before qualification",
      );
    }
    await waitForLiveOwnerLeaseExpiryForQualification({
      databaseFile: s.recoveryDatabaseFile,
      executionId: oldAction.executionId,
      pauseEvidence: liveOwnerPauseEvidence,
      expected: {
        workerId: exactOldLeaseOwner.workerId,
        workerIncarnationId: exactOldLeaseOwner.workerIncarnationId,
        generation: 1,
        expiresAt: liveLeaseBeforeQualification.expires_at,
      },
      daemon: { snapshot: fixture.daemonProcessSnapshot },
    });
    expect(
      readRows(s.recoveryDatabaseFile).leases.find(
        (lease) => lease.execution_id === oldAction.executionId,
      ),
    ).toEqual(liveLeaseBeforeQualification);
    assertApprovalFencingBeforeCommandBlocked();
  } else {
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: s.recoveryDatabaseFile,
      executionId: oldAction.executionId,
      daemon: {
        crash: fixture.crash,
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
  }

  if (crashSide === "legacy-p32-upgrade") {
    s.recoveryDatabaseFile = await makePreBindingP32Copy(
      fixture.databaseFile,
      resolve(fixture.directory, "p32-pre-binding.db"),
      priorCommittedCommandId ?? "",
    );
    const baselineFile = resolve(fixture.directory, "p32-baseline.db");
    await createP32MigrationBaseline(baselineFile);
    const baseline = new DatabaseSync(s.recoveryDatabaseFile, {
      readOnly: true,
    });
    const pristineP32 = new DatabaseSync(baselineFile, {
      readOnly: true,
    });
    try {
      expect(
        Number(
          (
            baseline.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ),
      ).toBe(32);
      expect(
        baseline
          .prepare("SELECT resolution FROM commands WHERE command_id = ?")
          .get(priorCommittedCommandId ?? "")?.resolution,
      ).toBe("Committed");
      expect(
        baseline
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assign_work_target_bindings'",
          )
          .all(),
      ).toHaveLength(0);
      expect(schemaSnapshot(baseline)).toEqual(schemaSnapshot(pristineP32));
    } finally {
      baseline.close();
      pristineP32.close();
    }
    await upgradeSchema44TestDatabase({
      databaseFilename: s.recoveryDatabaseFile,
      p39ReportFilename: resolve(
        fixture.directory,
        "p32-upgrade-p39-report.db",
      ),
    });
    const schema44 = new DatabaseSync(s.recoveryDatabaseFile, {
      readOnly: true,
    });
    let v44ReceiptJson: string | null = null;
    try {
      expect(
        Number(
          (
            schema44.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ),
      ).toBe(44);
      const receipt = schema44
        .prepare(
          "SELECT resolution, result_json FROM commands WHERE command_id = ?",
        )
        .get(priorCommittedCommandId ?? "") as
        | { resolution: string; result_json: string | null }
        | undefined;
      expect(receipt?.resolution).toBe("Committed");
      expect(receipt?.result_json).not.toBeNull();
      v44ReceiptJson = receipt?.result_json ?? null;
      expect(
        schema44
          .prepare(
            "SELECT command_id FROM assign_work_target_bindings WHERE command_id = ?",
          )
          .all(priorCommittedCommandId ?? ""),
      ).toHaveLength(0);
      const inboxColumns = (
        schema44.prepare("PRAGMA table_info(inbox_entries)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(inboxColumns).toEqual([
        "workspace_id",
        "entry_key",
        "kind",
        "summary",
        "correlation_id",
        "admitted_at",
        "consumed_at",
      ]);
      const verificationColumns = (
        schema44.prepare("PRAGMA table_info(verifications)").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
      expect(verificationColumns).not.toContain("criteria_results");
      expect(verificationColumns).not.toContain("snapshot_status");
      expect(
        schema44
          .prepare(
            `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
                   AND name IN ('tool_invocations_observation_insert_guard',
                                'tool_invocations_observation_update_guard')
                   ORDER BY name`,
          )
          .all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "tool_invocations_observation_insert_guard",
            sql: expect.stringContaining("ApprovalRejected"),
          }),
          expect.objectContaining({
            name: "tool_invocations_observation_update_guard",
            sql: expect.stringContaining("ApprovalRejected"),
          }),
        ]),
      );
    } finally {
      schema44.close();
    }
    await upgradeSchema44ToCurrentTestDatabase({
      databaseFilename: s.recoveryDatabaseFile,
    });
    const schema57 = new DatabaseSync(s.recoveryDatabaseFile, {
      readOnly: true,
    });
    try {
      expect(
        Number(
          (
            schema57.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ),
      ).toBe(57);
      expect(
        schema57
          .prepare(
            "SELECT resolution, result_json FROM commands WHERE command_id = ?",
          )
          .get(priorCommittedCommandId ?? ""),
      ).toEqual({ resolution: "Committed", result_json: v44ReceiptJson });
      expect(
        schema57
          .prepare(
            "SELECT command_id FROM assign_work_target_bindings WHERE command_id = ?",
          )
          .all(priorCommittedCommandId ?? ""),
      ).toHaveLength(0);
    } finally {
      schema57.close();
    }
  }
};

export const ah10PhaseNewGeneration = async (
  s: Ah10ScenarioState,
): Promise<void> => {
  const {
    crashSide,
    targetObjective,
    corruptResult,
    attentionBefore,
    attentionAfter,
    events,
    assignWorkCalls,
    targetWorkspaceRef,
    recoveryDatabaseFile,
    priorCommittedCommandId,
  } = s;
  const fixture = s.fixture!;
  const oldAction = s.oldAction!;
  const providerTurnId = s.providerTurnId!;
  const logicalActionId = s.logicalActionId!;
  const callRef = s.callRef!;
  const newDaemon = await fixture.startAdditionalDaemon({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_DB: recoveryDatabaseFile,
      ARBOR_AH10_ROLE: "new",
      ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED: "0",
      ...(attentionBefore || attentionAfter
        ? {
            ARBOR_AH10_BINDING_ATTENTION_BOUNDARY: attentionBefore
              ? "before"
              : "after",
          }
        : {}),
    },
    onStdout: (line) => pushProbe(events, line),
  });
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
  ).catch((error: unknown) => {
    throw new Error(
      `Direct-child AssignWork gen1 lease absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(recoveryDatabaseFile))}; daemon=${newDaemon.daemonErrors.join(" | ")}`,
    );
  });
  if (newLease === undefined) {
    throw new Error("Direct-child AssignWork gen1 did not acquire lease");
  }
  if (crashSide === "legacy-p32-upgrade") {
    const upgraded = readRows(recoveryDatabaseFile);
    expect(upgraded.schemaVersion).toBe(57);
    expect(upgraded.assignWorkTargetBindings).toHaveLength(0);
    expect(
      upgraded.commands.find(
        (command) => command.command_id === priorCommittedCommandId,
      )?.resolution,
    ).toBe("Committed");
    const upgradedDb = new DatabaseSync(recoveryDatabaseFile, {
      readOnly: true,
    });
    try {
      const p35Tables = upgradedDb
        .prepare(
          `SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name IN (
                    'workspace_resource_activation_intents',
                    'workspace_resource_activation_attention_rows'
                  )
                ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(p35Tables.map((row) => row.name)).toEqual([
        "workspace_resource_activation_attention_rows",
        "workspace_resource_activation_intents",
      ]);
      expect(
        (
          upgradedDb
            .prepare(
              "SELECT COUNT(*) AS count FROM workspace_resource_activation_intents",
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);
      expect(
        (
          upgradedDb
            .prepare(
              "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows",
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);
    } finally {
      upgradedDb.close();
    }
  }
  expect(newLease.fencingGeneration).toBe(
    crashSide === "approval-committed" ||
      crashSide === "approval-fencing-before"
      ? 2
      : 1,
  );
  const newAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionKind === "assign_work" &&
          event.executionId === oldAction.executionId &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    30_000,
  );
  if (newAction === undefined) {
    throw new Error("Direct-child AssignWork gen1 ActionIntent absent");
  }
  expect(newAction.providerTurnId).toBe(providerTurnId);
  expect(newAction.logicalActionId).toBe(logicalActionId);
  expect(newAction.callRef).toBe(callRef);
  expect(assignWorkCalls).toHaveLength(1);

  s.resultDaemon = newDaemon;
  if (attentionBefore || attentionAfter) {
    releaseGate(fixture, "new", "action-intent");
    const expectedBoundary = attentionBefore
      ? "AH10BeforeAssignWorkBindingAttentionCommit"
      : "AH10AfterAssignWorkBindingAttentionCommit";
    const attentionBoundary = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === expectedBoundary &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.committedCommandId === priorCommittedCommandId,
        ),
      (event) => event !== undefined,
      20_000,
    );
    if (attentionBoundary === undefined) {
      throw new Error(`missing ${expectedBoundary} probe`);
    }
    const atBoundary = readRows(recoveryDatabaseFile);
    const expectedFactCount = attentionAfter ? 1 : 0;
    expect(atBoundary.bindingAttentionFacts).toHaveLength(expectedFactCount);
    expect(atBoundary.bindingAttentionEvents).toHaveLength(expectedFactCount);
    await newDaemon.crash();
    const afterAttentionKill = readRows(recoveryDatabaseFile);
    expect(afterAttentionKill.bindingAttentionFacts).toHaveLength(
      expectedFactCount,
    );
    expect(afterAttentionKill.bindingAttentionEvents).toHaveLength(
      expectedFactCount,
    );
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: recoveryDatabaseFile,
      executionId: oldAction.executionId,
      daemon: {
        crash: newDaemon.crash,
        snapshot: newDaemon.daemonProcessSnapshot,
      },
    });
    const restartedDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    s.resultDaemon = restartedDaemon;
    const restartedLease = await waitForPublic(
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
    expect(restartedLease?.fencingGeneration).toBe(2);
  }

  s.oldRejectedCommandId = "";
  if (crashSide === "approval-fencing-before") {
    releaseGate(fixture, "old", "assign-work-authorized");
    const rejected = await waitForPublic(
      async () => fencedReceipts(readRows(recoveryDatabaseFile)),
      (rows) => rows.length === 1,
      20_000,
    );
    s.oldRejectedCommandId = rejected[0]?.command_id ?? "";
    expect(s.oldRejectedCommandId).toMatch(/^cmd_/u);
    const beforeRetry = readRows(recoveryDatabaseFile);
    expect(targetWorks(beforeRetry, targetObjective)).toHaveLength(0);
    expect(beforeRetry.assignWorkTargetBindings).toHaveLength(0);
    expect(
      beforeRetry.workAssignedEvents.filter((event) => {
        try {
          return (
            (JSON.parse(event.payload_json) as { objective?: string })
              .objective === targetObjective
          );
        } catch {
          return false;
        }
      }),
    ).toHaveLength(0);
    const targetApprovals = beforeRetry.approvals.filter(
      (approval) => approval.target_ref === targetWorkspaceRef,
    );
    expect(targetApprovals).toHaveLength(1);
    expect(targetApprovals[0]).toMatchObject({
      target_ref: targetWorkspaceRef,
      state: "Approved",
      revision: 1,
      consumed_by: null,
      binding_proven: 1,
    });
    await fixture.crash();
  } else if (
    crashSide === "committed" ||
    crashSide === "corrupt-sibling" ||
    crashSide === "approval-committed"
  ) {
    s.oldRejectedCommandId = "";
  } else {
    releaseGate(fixture, "old", "action-intent");
  }
  if (crashSide === "before") {
    const beforeCommit = await waitForPublic(
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
    if (beforeCommit?.commandId === undefined) {
      throw new Error("Direct-child FencingRejected precommit probe absent");
    }
    s.oldRejectedCommandId = beforeCommit.commandId;
    expect(s.oldRejectedCommandId).toMatch(/^cmd_/u);
    expect(fencedReceipts(readRows(recoveryDatabaseFile))).toHaveLength(0);
    expect(
      targetWorks(readRows(recoveryDatabaseFile), targetObjective),
    ).toHaveLength(0);
  } else if (crashSide === "after") {
    const rejected = await waitForPublic(
      async () => fencedReceipts(readRows(recoveryDatabaseFile)),
      (rows) => rows.length === 1,
      15_000,
    );
    s.oldRejectedCommandId = rejected[0]?.command_id ?? "";
    expect(s.oldRejectedCommandId).toMatch(/^cmd_/u);
    expect(
      targetWorks(readRows(recoveryDatabaseFile), targetObjective),
    ).toHaveLength(0);
  }

  if (
    crashSide !== "committed" &&
    crashSide !== "corrupt-sibling" &&
    crashSide !== "approval-committed" &&
    crashSide !== "approval-fencing-before" &&
    crashSide !== "legacy-unbound" &&
    crashSide !== "legacy-p32-upgrade" &&
    crashSide !== "retired-after-commit" &&
    crashSide !== "grant-revoked-after-commit" &&
    crashSide !== "non-root-parent" &&
    crashSide !== "attention-before" &&
    crashSide !== "attention-after" &&
    !corruptResult &&
    crashSide !== "binding-before"
  ) {
    await fixture.crash();
  }
  if (crashSide === "before") {
    const afterKill = readRows(recoveryDatabaseFile);
    expect(fencedReceipts(afterKill)).toHaveLength(0);
    expect(
      afterKill.commands.some(
        (command) => command.command_id === s.oldRejectedCommandId,
      ),
    ).toBe(false);
  }
  releaseGate(fixture, "new", "action-intent");
  Object.assign(s, { newDaemon, newLease });
};
