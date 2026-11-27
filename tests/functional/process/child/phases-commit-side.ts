import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  functionalId,
  waitForApproval,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah10ScenarioState,
  ah10Child,
  releaseGate,
  removeBindingForLegacyFixture,
  retargetBindingToSibling,
  retireTargetAfterCommit,
} from "./support.js";
import {
  type ControlResult,
  parseWorkspacesResult,
  readRows,
  targetWorks,
} from "./support-rows.js";

export const ah10PhasePinOldAction = async (
  s: Ah10ScenarioState,
): Promise<void> => {
  const {
    crashSide,
    marker,
    childName,
    sourceObjective,
    targetObjective,
    corruptResult,
    events,
    listWorkspaceCalls,
    assignWorkCalls,
    providerTrace,
    recoveryDatabaseFile,
    assignmentParentWorkspaceId,
    childWorkspaceId,
    parentWorkId,
  } = s;
  const fixture = s.fixture!;
  const client = s.client!;
  const project = s.project!;
  const seedParentWork = s.seedParentWork!;
  await fixture.crash();
  await fixture.restart({
    entry: ah10Child,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "assign_work",
      ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE:
        crashSide === "approval-fencing-before" ? "1" : "0",
      ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
        crashSide === "before" ? "1" : "0",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN:
        crashSide === "committed" ||
        crashSide === "corrupt-sibling" ||
        crashSide === "approval-committed" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "legacy-unbound" ||
        crashSide === "retired-after-commit" ||
        crashSide === "grant-revoked-after-commit" ||
        crashSide === "non-root-parent" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after" ||
        corruptResult
          ? "1"
          : "0",
      ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "assign_work",
      ARBOR_AH10_PAUSE_BEFORE_ASSIGN_WORK_BINDING_COMMIT:
        crashSide === "binding-before" ? "1" : "0",
      ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED:
        crashSide === "approval-fencing-before" ? "1" : "0",
    },
  });
  await client.command(project.projectId, "SteerWork", {
    workId: parentWorkId,
    workspaceId: assignmentParentWorkspaceId,
    expectedWorkRevision: seedParentWork.revision,
    steer: {
      severity: "Normal",
      guidance: `Resume AH10 direct-child assignment qualification ${marker}.`,
    },
    provenance: { source: "HumanInput" },
  });
  const resumedParentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
      } | null>("current-work", {
        workspaceId: assignmentParentWorkspaceId,
      }),
    (work) =>
      work?.workId === parentWorkId &&
      work.revision === seedParentWork.revision + 1,
  );
  expect(resumedParentWork).toMatchObject({
    workId: parentWorkId,
    objective: sourceObjective,
    revision: seedParentWork.revision + 1,
    status: "Open",
  });

  const oldAction = await waitForPublic(
    async () =>
      events.find(
        (event) =>
          event.role === "old" &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionKind === "assign_work" &&
          event.actionIndex === 0,
      ),
    (event) => event !== undefined,
    45_000,
  ).catch((error: unknown) => {
    throw new Error(
      `Direct-child AssignWork ActionIntent absent: ${error instanceof Error ? error.message : String(error)}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; assignWorkCalls=${JSON.stringify(assignWorkCalls)}; targetRef=${s.targetWorkspaceRef}; provider=${JSON.stringify(providerTrace)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readRows(recoveryDatabaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  if (oldAction === undefined || s.targetWorkspaceRef === undefined) {
    throw new Error("the model did not reach direct-child AssignWork");
  }
  const providerTurnId = oldAction.providerTurnId;
  const logicalActionId = oldAction.logicalActionId;
  const callRef = oldAction.callRef;
  if (
    providerTurnId === undefined ||
    logicalActionId === undefined ||
    callRef === undefined
  ) {
    throw new Error("Direct-child AssignWork omitted pinned identity");
  }
  expect(listWorkspaceCalls).toHaveLength(1);
  expect(assignWorkCalls).toHaveLength(1);
  expect(s.targetWorkspaceRef).toMatch(/^wref_[a-f0-9]{64}$/u);
  expect(s.targetWorkspaceRef).not.toContain(childWorkspaceId);

  const listControlRows = readRows(recoveryDatabaseFile).controlResults.filter(
    (row) =>
      (JSON.parse(row.payload_json) as ControlResult).actionKind ===
      "list_workspaces",
  );
  expect(listControlRows).toHaveLength(1);
  const listControlRow = listControlRows[0];
  if (listControlRow === undefined) {
    throw new Error("list_workspaces ControlResult row is absent");
  }
  const listControlResult = JSON.parse(
    listControlRow.payload_json,
  ) as ControlResult;
  if (listControlResult?.callRef === undefined) {
    throw new Error("list_workspaces ControlResult omitted its callRef");
  }
  expect(listControlResult.callRef).toMatch(/^call_/u);
  const persistedListResult = parseWorkspacesResult(
    listControlRow,
  ).directChildren?.find((child) => child.name === childName);
  expect(persistedListResult).toEqual({
    ref: s.targetWorkspaceRef,
    name: childName,
    responsibilitySummary: `own the bounded responsibility for ${marker}`,
    currentWorkSummary: null,
    openWorkCount: 0,
    readyResults: [],
    revision: 0,
  });

  // The old daemon is held at the exact Agent ActionIntent boundary. The
  // target is the wref recovered from its persisted successful
  // list_workspaces ControlResult, not a fabricated or derived ref.
  if (
    crashSide !== "approval-committed" &&
    crashSide !== "approval-fencing-before"
  ) {
    s.assignmentGrantId = functionalId("pgr");
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: s.assignmentGrantId,
      issuer: "user:local",
      subject: {
        _tag: "WorkspaceAgent",
        workspaceId: assignmentParentWorkspaceId,
      },
      capability: "core.control.assign-work",
      target: s.targetWorkspaceRef,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  }
  const grantRows = readRows(recoveryDatabaseFile).permissionGrants.filter(
    (grant) =>
      grant.subject_kind === "WorkspaceAgent" &&
      grant.subject_ref === assignmentParentWorkspaceId &&
      grant.capability === "core.control.assign-work" &&
      grant.target === s.targetWorkspaceRef &&
      grant.state === "Active",
  );
  expect(grantRows).toHaveLength(
    crashSide === "approval-committed" ||
      crashSide === "approval-fencing-before"
      ? 0
      : 1,
  );
  expect(
    targetWorks(readRows(recoveryDatabaseFile), targetObjective),
  ).toHaveLength(0);
  Object.assign(s, {
    oldAction,
    providerTurnId,
    logicalActionId,
    callRef,
    listControlRow,
    listControlResult,
    grantRows,
  });
};

export const ah10PhaseCommitSide = async (
  s: Ah10ScenarioState,
): Promise<void> => {
  const {
    crashSide,
    marker,
    targetObjective,
    corruptResult,
    events,
    assignWorkCalls,
    providerTrace,
    targetWorkspaceRef,
    recoveryDatabaseFile,
    assignmentParentWorkspaceId,
    childWorkspaceId,
    siblingWorkspaceId,
    parentWorkId,
    grantRows,
    assignmentGrantId,
  } = s;
  const fixture = s.fixture!;
  const client = s.client!;
  const project = s.project!;
  const oldAction = s.oldAction!;
  const providerTurnId = s.providerTurnId!;
  const logicalActionId = s.logicalActionId!;
  const callRef = s.callRef!;
  if (
    crashSide === "committed" ||
    crashSide === "corrupt-sibling" ||
    crashSide === "approval-committed" ||
    crashSide === "legacy-unbound" ||
    crashSide === "legacy-p32-upgrade" ||
    crashSide === "retired-after-commit" ||
    crashSide === "grant-revoked-after-commit" ||
    crashSide === "non-root-parent" ||
    crashSide === "attention-before" ||
    crashSide === "attention-after" ||
    corruptResult
  ) {
    releaseGate(fixture, "old", "action-intent");
    if (crashSide === "approval-committed") {
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH10 exact target binding qualification",
      });
    }
    const controlReturned = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.callRef === callRef,
        ),
      (event) => event !== undefined,
      15_000,
    ).catch((error: unknown) => {
      throw new Error(
        `Direct-child AssignWork post-handler probe absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; results=${JSON.stringify(
          readRows(recoveryDatabaseFile)
            .controlResults.map((row) => JSON.parse(row.payload_json))
            .filter((result) => result.actionKind === "assign_work"),
        )}; works=${JSON.stringify(targetWorks(readRows(recoveryDatabaseFile), targetObjective))}; commands=${JSON.stringify(readRows(recoveryDatabaseFile).commands.filter((row) => row.resolution === "Committed"))}; bindings=${JSON.stringify(readRows(recoveryDatabaseFile).assignWorkTargetBindings)}; actions=${JSON.stringify(readRows(recoveryDatabaseFile).actions.filter((row) => row.execution_id === oldAction.executionId))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (controlReturned === undefined) {
      throw new Error("Direct-child AssignWork post-handler probe absent");
    }
    const beforeCrash = readRows(recoveryDatabaseFile);
    const assigned = targetWorks(beforeCrash, targetObjective);
    expect(assigned).toHaveLength(1);
    const priorReceipt = beforeCrash.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null)
        return false;
      try {
        const result = JSON.parse(command.result_json) as {
          workId?: string;
          workspaceId?: string;
          lifecycle?: string;
          revision?: number;
        };
        return (
          result.workId === assigned[0]?.work_id &&
          result.workspaceId === childWorkspaceId &&
          result.lifecycle === "Open" &&
          result.revision === 0
        );
      } catch {
        return false;
      }
    });
    expect(priorReceipt).toHaveLength(1);
    s.priorCommittedCommandId = priorReceipt[0]?.command_id;
    expect(s.priorCommittedCommandId).toMatch(/^cmd_/u);
    const bindings = beforeCrash.assignWorkTargetBindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      command_id: s.priorCommittedCommandId,
      execution_id: oldAction.executionId,
      provider_turn_id: providerTurnId,
      logical_action_id: logicalActionId,
      call_ref: callRef,
      parent_workspace_id: assignmentParentWorkspaceId,
      parent_work_id: parentWorkId,
      target_workspace_ref: targetWorkspaceRef,
      target_workspace_id: childWorkspaceId,
      work_id: assigned[0]?.work_id,
      authority_kind:
        crashSide === "approval-committed"
          ? "ActionApproval"
          : "PermissionGrant",
    });
    const savedAuthority = JSON.parse(
      bindings[0]?.authority_evidence_json ?? "null",
    ) as {
      _tag?: string;
      targetRef?: string;
      approvalId?: string;
      approvalRevision?: number;
    };
    expect(savedAuthority).toMatchObject({
      targetRef: targetWorkspaceRef,
      _tag:
        crashSide === "approval-committed"
          ? "ActionApproval"
          : "PermissionGrant",
    });
    if (crashSide === "approval-committed") {
      const consumed = beforeCrash.approvals.find(
        (approval) => approval.approval_id === savedAuthority.approvalId,
      );
      expect(consumed).toMatchObject({
        target_ref: targetWorkspaceRef,
        state: "Consumed",
        revision: (savedAuthority.approvalRevision ?? -1) + 1,
        consumed_by: s.priorCommittedCommandId,
        binding_proven: 1,
      });
    }
    expect(
      beforeCrash.workAssignedEvents.filter((event) => {
        try {
          return (
            (JSON.parse(event.payload_json) as { workId?: string }).workId ===
            assigned[0]?.work_id
          );
        } catch {
          return false;
        }
      }),
    ).toHaveLength(1);
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: providerTurnId,
        logical_action_id: logicalActionId,
        call_ref: callRef,
        action_kind: "assign_work",
        state: "Pending",
        observation_source_ref: null,
      }),
    );
    expect(
      beforeCrash.observations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
      ),
    ).toHaveLength(1);
    expect(
      beforeCrash.providerAttempts.filter(
        (row) => row.provider_turn_id === providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ attempt_no: 0, outcome: "Success" })]);
    expect(assignWorkCalls).toHaveLength(1);
    if (
      crashSide === "corrupt-sibling" ||
      crashSide === "attention-before" ||
      crashSide === "attention-after"
    ) {
      retargetBindingToSibling(
        recoveryDatabaseFile,
        s.priorCommittedCommandId ?? "",
        siblingWorkspaceId,
      );
      expect(
        readRows(recoveryDatabaseFile).assignWorkTargetBindings[0]
          ?.target_workspace_id,
      ).toBe(siblingWorkspaceId);
    } else if (corruptResult) {
      const commandId = s.priorCommittedCommandId;
      if (commandId === undefined) {
        throw new Error("Committed AssignWork receipt has no CommandId");
      }
      const rawCorruptResult =
        crashSide === "wrong-shape-result"
          ? JSON.stringify({ private_marker: marker })
          : `{"private_marker_${marker}":`;
      s.corruptedResultJson = rawCorruptResult;
      const corruptDb = new DatabaseSync(recoveryDatabaseFile);
      try {
        const changed = corruptDb
          .prepare(
            "UPDATE commands SET result_json = ? WHERE command_id = ? AND resolution = 'Committed'",
          )
          .run(rawCorruptResult, commandId);
        expect(Number(changed.changes)).toBe(1);
        expect(
          (
            corruptDb
              .prepare("SELECT result_json FROM commands WHERE command_id = ?")
              .get(commandId) as { result_json: string }
          ).result_json,
        ).toBe(rawCorruptResult);
      } finally {
        corruptDb.close();
      }
    } else if (crashSide === "legacy-unbound") {
      removeBindingForLegacyFixture(
        recoveryDatabaseFile,
        s.priorCommittedCommandId ?? "",
      );
      expect(
        readRows(recoveryDatabaseFile).assignWorkTargetBindings,
      ).toHaveLength(0);
    } else if (crashSide === "retired-after-commit") {
      retireTargetAfterCommit(recoveryDatabaseFile, childWorkspaceId);
      expect(
        readRows(recoveryDatabaseFile).workspaceLifecycles.find(
          (workspace) => workspace.workspace_id === childWorkspaceId,
        )?.lifecycle,
      ).toBe("Retired");
    } else if (crashSide === "grant-revoked-after-commit") {
      if (assignmentGrantId === undefined) {
        throw new Error("Grant-authorized case has no PermissionGrantId");
      }
      await client.command(project.projectId, "RevokePermission", {
        permissionGrantId: assignmentGrantId,
      });
      expect(
        readRows(recoveryDatabaseFile).permissionGrants.find(
          (grant) => grant.permission_grant_id === assignmentGrantId,
        )?.state,
      ).toBe("Revoked");
    }
    await fixture.crash();
  } else if (crashSide === "binding-before") {
    releaseGate(fixture, "old", "action-intent");
    const beforeBindingCommit = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeAssignWorkBindingCommit" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      15_000,
    ).catch((error: unknown) => {
      const snapshot = readRows(recoveryDatabaseFile);
      throw new Error(
        `AssignWork transaction precommit probe absent: ${error instanceof Error ? error.message : String(error)}; executionEvents=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; assigns=${JSON.stringify(snapshot.controlResults.map((row) => JSON.parse(row.payload_json)).filter((result) => result.actionKind === "assign_work"))}; targetWorks=${JSON.stringify(targetWorks(snapshot, targetObjective))}; bindings=${JSON.stringify(snapshot.assignWorkTargetBindings)}; grants=${JSON.stringify(snapshot.permissionGrants)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (beforeBindingCommit?.commandId === undefined) {
      throw new Error("Direct-child binding-before-commit probe absent");
    }
    s.priorCommittedCommandId = beforeBindingCommit.commandId;
    expect(s.priorCommittedCommandId).toMatch(/^cmd_/u);
    const uncommitted = readRows(recoveryDatabaseFile);
    expect(targetWorks(uncommitted, targetObjective)).toHaveLength(0);
    expect(uncommitted.assignWorkTargetBindings).toHaveLength(0);
    expect(
      uncommitted.workAssignedEvents.filter(
        (event) => event.caused_by_command_id === s.priorCommittedCommandId,
      ),
    ).toHaveLength(0);
    expect(
      uncommitted.commands.some(
        (command) => command.command_id === s.priorCommittedCommandId,
      ),
    ).toBe(false);
    expect(uncommitted.permissionGrants).toEqual(grantRows);
    await fixture.crash();
    const afterKill = readRows(recoveryDatabaseFile);
    expect(targetWorks(afterKill, targetObjective)).toHaveLength(0);
    expect(afterKill.assignWorkTargetBindings).toHaveLength(0);
    expect(
      afterKill.commands.some(
        (command) => command.command_id === s.priorCommittedCommandId,
      ),
    ).toBe(false);
  } else if (crashSide === "approval-fencing-before") {
    releaseGate(fixture, "old", "action-intent");
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "qualify fenced CAPA non-consumption",
    });
    s.assignWorkAuthorizedPause = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterAssignWorkAuthorizedBeforeCommandSubmission" &&
            event.pauseRequested === true &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === logicalActionId &&
            event.callRef === callRef,
        ),
      (event) => event !== undefined,
      20_000,
    ).catch((error: unknown) => {
      const snapshot = readRows(recoveryDatabaseFile);
      throw new Error(
        `AssignWork authorization pre-command probe absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; approvals=${JSON.stringify(snapshot.approvals)}; controls=${JSON.stringify(snapshot.controlResults.map((row) => JSON.parse(row.payload_json)))}; actions=${JSON.stringify(snapshot.actions.filter((entry) => entry.execution_id === oldAction.executionId))}; provider=${JSON.stringify(providerTrace)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (s.assignWorkAuthorizedPause === undefined) {
      throw new Error("AssignWork authorization pre-command pause was absent");
    }

    writeFileSync(
      resolve(fixture.directory, "ah10-gates", "old-lease-renewal.pause"),
      "pause old owner renewal after AssignWork authorization",
    );
    const renewal = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeLeaseRenewal" &&
            event.executionId === oldAction.executionId &&
            event.fencingGeneration === 1 &&
            event.pauseRequested === true,
        ),
      (event) => event !== undefined,
      20_000,
    );
    expect(renewal?.fencingGeneration).toBe(1);
    if (renewal === undefined) {
      throw new Error("AssignWork live-owner renewal pause evidence absent");
    }
    s.oldLeaseOwner = events.find(
      (event) =>
        event.role === "old" &&
        event.boundary === "AH10AfterLeaseAcquired" &&
        event.executionId === oldAction.executionId &&
        event.fencingGeneration === 1,
    );
    s.oldLeaseOwnerWorkerId = s.oldLeaseOwner?.workerId;
    s.oldLeaseOwnerIncarnationId = s.oldLeaseOwner?.workerIncarnationId;
    if (
      s.oldLeaseOwnerWorkerId === undefined ||
      s.oldLeaseOwnerIncarnationId === undefined
    ) {
      throw new Error("AssignWork live-owner lease identity probe was absent");
    }
    s.liveOwnerPauseEvidence = {
      boundary: "AH10BeforeLeaseRenewal",
      pauseRequested: renewal.pauseRequested === true,
      executionId: renewal.executionId,
      fencingGeneration: renewal.fencingGeneration ?? -1,
    };
  } else {
    const oldLeasePause = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeLeaseRenewal" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      20_000,
    );
    if (oldLeasePause === undefined) {
      throw new Error("Direct-child AssignWork old lease probe was absent");
    }
    expect(oldLeasePause.fencingGeneration).toBe(0);
    s.liveOwnerPauseEvidence = {
      boundary: "AH10BeforeLeaseRenewal",
      pauseRequested: oldLeasePause.pauseRequested === true,
      executionId: oldLeasePause.executionId,
      fencingGeneration: oldLeasePause.fencingGeneration ?? -1,
    };
  }
};
