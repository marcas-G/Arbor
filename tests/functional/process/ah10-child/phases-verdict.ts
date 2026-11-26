import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { newUuid7 } from "../../../../packages/application/src/formation-plan.js";
import {
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import { type Ah10ScenarioState, releaseGate } from "./support.js";
import {
  type ControlResult,
  fencedReceipts,
  readRows,
  targetWorks,
} from "./support-rows.js";

export const ah10PhaseVerdict = async (s: Ah10ScenarioState): Promise<void> => {
  const {
    crashSide,
    marker,
    targetObjective,
    targetWhy,
    targetReason,
    constraints,
    mission,
    corruptResult,
    events,
    listWorkspaceCalls,
    assignWorkCalls,
    targetWorkspaceRef,
    recoveryDatabaseFile,
    assignmentParentWorkspaceId,
    childWorkspaceId,
    siblingWorkspaceId,
    parentWorkId,
    assignmentGrantId,
    priorCommittedCommandId,
    corruptedResultJson,
    oldRejectedCommandId,
  } = s;
  const fixture = s.fixture!;
  const project = s.project!;
  const oldAction = s.oldAction!;
  const providerTurnId = s.providerTurnId!;
  const logicalActionId = s.logicalActionId!;
  const callRef = s.callRef!;
  const listControlRow = s.listControlRow!;
  const listControlResult = s.listControlResult!;
  const newDaemon = s.newDaemon!;
  const newLease = s.newLease!;
  const resultDaemon = s.resultDaemon!;
  const completed = await waitForPublic(
    async () => readRows(recoveryDatabaseFile),
    (rows) => {
      if (
        crashSide === "corrupt-sibling" ||
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after" ||
        corruptResult
      ) {
        return (
          rows.bindingAttentionFacts.length === 1 &&
          rows.actions.some(
            (action) =>
              action.execution_id === oldAction.executionId &&
              action.logical_action_id === logicalActionId &&
              action.state === "Pending" &&
              action.observation_source_ref === null,
          )
        );
      }
      return (
        targetWorks(rows, targetObjective).length === 1 &&
        rows.actions.some(
          (action) =>
            action.execution_id === oldAction.executionId &&
            action.logical_action_id === logicalActionId &&
            action.state === "Applied",
        ) &&
        rows.controlResults.some((row) => {
          const result = JSON.parse(row.payload_json) as ControlResult;
          return (
            result.actionKind === "assign_work" && result.callRef === callRef
          );
        })
      );
    },
    30_000,
  ).catch((error: unknown) => {
    const snapshot = readRows(recoveryDatabaseFile);
    throw new Error(
      `direct-child recovery did not converge: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.filter((event) => event.executionId === oldAction.executionId))}; actions=${JSON.stringify(snapshot.actions.filter((entry) => entry.execution_id === oldAction.executionId))}; commands=${JSON.stringify(snapshot.commands.filter((entry) => entry.command_id === oldRejectedCommandId || entry.result_json?.includes(targetObjective) || entry.terminal_error_json?.includes("FencingRejected")))}; approvals=${JSON.stringify(snapshot.approvals)}; assignments=${JSON.stringify(targetWorks(snapshot, targetObjective))}; daemonErrors=${fixture.daemonErrors.join(" | ")}; newDaemonErrors=${newDaemon.daemonErrors.join(" | ")}`,
    );
  });

  const assignedWorks = targetWorks(completed, targetObjective);
  expect(assignedWorks).toHaveLength(1);
  const assigned = assignedWorks[0];
  if (assigned === undefined) {
    throw new Error("Direct-child AssignWork did not persist its Work row");
  }
  expect(assigned).toMatchObject({
    project_id: project.projectId,
    workspace_id: childWorkspaceId,
    objective: targetObjective,
    why: targetWhy,
    constraints: JSON.stringify(constraints),
    completion_expectation: `the direct child owns a verified outcome for ${marker}`,
    verification_mission: JSON.stringify(mission),
    lifecycle: "Open",
    revision: 0,
  });
  expect(JSON.parse(assigned.provenance)).toEqual({
    predecessorWorkId: parentWorkId,
    reason: targetReason,
  });

  const assignedEvents = completed.workAssignedEvents.filter((event) => {
    try {
      const payload = JSON.parse(event.payload_json) as {
        workId?: string;
        workspaceId?: string;
      };
      return payload.workId === assigned.work_id;
    } catch {
      return false;
    }
  });
  expect(assignedEvents).toHaveLength(1);
  expect(assignedEvents[0]?.aggregate_ref).toBe(childWorkspaceId);

  const committed = completed.commands.filter((command) => {
    if (command.resolution !== "Committed" || command.result_json === null) {
      return false;
    }
    try {
      const result = JSON.parse(command.result_json) as {
        workId?: string;
        workspaceId?: string;
        lifecycle?: string;
        revision?: number;
      };
      return (
        result.workId === assigned.work_id &&
        result.workspaceId === childWorkspaceId &&
        result.lifecycle === "Open" &&
        result.revision === 0
      );
    } catch {
      return false;
    }
  });
  expect(committed, JSON.stringify(committed)).toHaveLength(
    corruptResult ? 0 : 1,
  );
  const highestObservedGeneration = Math.max(
    newLease.fencingGeneration ?? 0,
    ...completed.leases
      .filter((lease) => lease.execution_id === oldAction.executionId)
      .map((lease) => lease.generation),
  );
  const occurrence = `${providerTurnId}:0`;
  // Command receipts do not store source-action columns. Enumerate the
  // deterministic command ID for every generation that could have
  // submitted this exact ProviderTurn/outputPosition action.
  const actionReceiptIds = new Set(
    Array.from({ length: highestObservedGeneration + 1 }, (_, generation) => {
      const seed =
        generation === 0
          ? occurrence
          : `${occurrence}:generation:${generation}`;
      return `cmd_${newUuid7("assign-work-command", seed)}`;
    }),
  );
  const actionReceipts = completed.commands.filter((command) =>
    actionReceiptIds.has(command.command_id),
  );
  expect(
    new Set(actionReceipts.map((command) => command.command_id)).size,
  ).toBe(actionReceipts.length);
  expect(
    actionReceipts.filter((command) => command.resolution === "Committed"),
  ).toHaveLength(1);
  if (corruptResult) {
    expect(actionReceipts).toHaveLength(1);
    expect(actionReceipts[0]).toMatchObject({
      command_id: priorCommittedCommandId,
      resolution: "Committed",
      result_json: corruptedResultJson,
    });
    expect(JSON.stringify(completed.bindingAttentionFacts)).not.toContain(
      marker,
    );
    expect(JSON.stringify(completed.bindingAttentionEvents)).not.toContain(
      marker,
    );
  } else {
    expect(actionReceipts).toContainEqual(committed[0]);
  }
  if (oldRejectedCommandId.length > 0) {
    expect(actionReceiptIds.has(oldRejectedCommandId)).toBe(true);
    const rejectedReceipt = actionReceipts.find(
      (command) => command.command_id === oldRejectedCommandId,
    );
    if (crashSide === "before") {
      expect(rejectedReceipt).toBeUndefined();
    } else {
      expect(rejectedReceipt?.resolution).toBe("TerminalRejected");
    }
  }
  if (
    crashSide === "committed" ||
    crashSide === "corrupt-sibling" ||
    crashSide === "approval-committed" ||
    crashSide === "legacy-unbound" ||
    crashSide === "legacy-p32-upgrade" ||
    crashSide === "retired-after-commit" ||
    crashSide === "grant-revoked-after-commit" ||
    crashSide === "non-root-parent"
  ) {
    expect(committed[0]?.command_id).toBe(priorCommittedCommandId);
  } else if (corruptResult) {
    expect(actionReceipts[0]?.command_id).toBe(priorCommittedCommandId);
  } else if (crashSide === "binding-before") {
    expect(committed[0]?.command_id).not.toBe(priorCommittedCommandId);
  } else {
    expect(committed[0]?.command_id).not.toBe(oldRejectedCommandId);
  }
  expect(assignedEvents[0]?.caused_by_command_id).toBe(
    corruptResult ? priorCommittedCommandId : committed[0]?.command_id,
  );
  expect(fencedReceipts(completed)).toHaveLength(
    crashSide === "before"
      ? 0
      : crashSide === "after" || crashSide === "approval-fencing-before"
        ? 1
        : 0,
  );

  const actionRows = completed.actions.filter(
    (action) => action.execution_id === oldAction.executionId,
  );
  expect(actionRows).toHaveLength(2);
  expect(
    actionRows.filter(
      (action) =>
        action.action_kind === "assign_work" && action.call_ref === callRef,
    ),
  ).toEqual([
    expect.objectContaining({
      provider_turn_id: providerTurnId,
      logical_action_id: logicalActionId,
      action_index: 0,
      call_ref: callRef,
      action_kind: "assign_work",
      state:
        crashSide === "corrupt-sibling" ||
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after" ||
        corruptResult
          ? "Pending"
          : "Applied",
      observation_source_ref:
        crashSide === "corrupt-sibling" ||
        crashSide === "legacy-unbound" ||
        crashSide === "legacy-p32-upgrade" ||
        crashSide === "attention-before" ||
        crashSide === "attention-after" ||
        corruptResult
          ? null
          : expect.any(String),
    }),
  ]);
  expect(
    actionRows.filter((action) => action.action_kind === "list_workspaces"),
  ).toHaveLength(1);
  const listAction = actionRows.find(
    (action) => action.action_kind === "list_workspaces",
  );
  const assignmentAction = actionRows.find(
    (action) => action.action_kind === "assign_work",
  );
  expect(listAction).toMatchObject({
    provider_turn_id: expect.stringMatching(/^ptn_/u),
    logical_step_no: 0,
    repair_attempt: 0,
    action_index: 0,
    call_ref: listControlResult.callRef,
    state: "Applied",
    observation_source_ref: expect.any(String),
  });
  expect(listAction?.observation_source_ref).toBe(listControlRow.source_ref);
  const finalListControlResults = completed.controlResults.filter((row) => {
    const result = JSON.parse(row.payload_json) as ControlResult;
    return (
      result.actionKind === "list_workspaces" &&
      result.callRef === listControlResult.callRef
    );
  });
  expect(finalListControlResults).toHaveLength(1);
  expect(finalListControlResults[0]?.source_ref).toBe(
    listAction?.observation_source_ref,
  );
  expect(assignmentAction?.provider_turn_id).toBe(providerTurnId);
  expect(assignmentAction?.logical_step_no).toBe(1);
  expect(assignmentAction?.repair_attempt).toBe(0);
  expect(listAction?.logical_action_id).not.toBe(logicalActionId);
  expect(listAction?.call_ref).not.toBe(callRef);
  const observation = completed.controlResults
    .map((row) => JSON.parse(row.payload_json) as ControlResult)
    .filter(
      (result) =>
        result.actionKind === "assign_work" && result.callRef === callRef,
    );
  if (
    crashSide === "corrupt-sibling" ||
    crashSide === "legacy-unbound" ||
    crashSide === "legacy-p32-upgrade" ||
    crashSide === "attention-before" ||
    crashSide === "attention-after" ||
    corruptResult
  ) {
    expect(observation).toHaveLength(0);
    expect(completed.bindingAttentionFacts).toHaveLength(1);
    expect(completed.bindingAttentionFacts[0]).toMatchObject({
      execution_id: oldAction.executionId,
      target_workspace_id: assignmentParentWorkspaceId,
      logical_action_id: logicalActionId,
      committed_command_id: priorCommittedCommandId,
      failure_code:
        crashSide === "legacy-unbound" || crashSide === "legacy-p32-upgrade"
          ? "LegacyUnbound"
          : "ReceiptMismatch",
    });
    const attentionEvents = completed.bindingAttentionEvents;
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]?.event_id).toBe(
      completed.bindingAttentionFacts[0]?.event_id,
    );
    expect(attentionEvents[0]).toMatchObject({
      project_id: project.projectId,
      aggregate_ref: assignmentParentWorkspaceId,
      caused_by_command_id: priorCommittedCommandId,
      correlation_ref: logicalActionId,
    });
    expect(
      JSON.parse(attentionEvents[0]?.payload_json ?? "null"),
    ).toMatchObject({
      attentionFactId: completed.bindingAttentionFacts[0]?.attention_fact_id,
      executionId: oldAction.executionId,
      targetWorkspaceId: assignmentParentWorkspaceId,
      logicalActionId,
      committedCommandId: priorCommittedCommandId,
      failureCode:
        crashSide === "legacy-unbound" || crashSide === "legacy-p32-upgrade"
          ? "LegacyUnbound"
          : "ReceiptMismatch",
    });
    const publicClient = makePublicClient(resultDaemon.baseUrl);
    const attention = await waitForPublic(
      () =>
        publicClient.view<{
          rows: ReadonlyArray<{
            source: string;
            severity: string;
            targetWorkspaceId: string;
            dedupKey: string;
            summaryRef: string;
            failureCode?: string;
            workId?: string;
          }>;
        }>("attention", { projectId: project.projectId }),
      (view) =>
        view.rows.some(
          (row) =>
            row.dedupKey ===
            completed.bindingAttentionFacts[0]?.attention_fact_id,
        ),
    );
    const bindingRows = attention.rows.filter(
      (row) => row.source === "AssignWorkTargetBindingFailure",
    );
    const terminalProviderRows = attention.rows.filter(
      (row) =>
        row.source === "TerminalProviderFailure" ||
        row.source === "TerminalProviderFailureIntegrity",
    );
    expect(bindingRows).toHaveLength(1);
    expect(terminalProviderRows).toHaveLength(1);
    expect(attention.rows.map((row) => row.source).sort()).toEqual([
      "AssignWorkTargetBindingFailure",
      "TerminalProviderFailure",
    ]);
    expect(new Set(attention.rows.map((row) => row.dedupKey)).size).toBe(
      attention.rows.length,
    );
    const terminalProviderRow = terminalProviderRows[0];
    if (
      terminalProviderRow === undefined ||
      terminalProviderRow.workId === undefined
    ) {
      throw new Error("terminal Provider Attention omitted its Work identity");
    }
    expect(terminalProviderRow).toMatchObject({
      source: "TerminalProviderFailure",
      severity: "ActionRequired",
      failureCode: "RequestRejected",
    });
    expect(terminalProviderRow.dedupKey).toMatch(
      new RegExp(
        `^terminal-provider-failure:${terminalProviderRow.workId}:0:[a-f0-9]{64}$`,
        "u",
      ),
    );
    expect(terminalProviderRow.targetWorkspaceId).not.toBe(
      assignmentParentWorkspaceId,
    );
    const terminalProviderEvidence = (() => {
      const db = new DatabaseSync(recoveryDatabaseFile, {
        readOnly: true,
      });
      try {
        return db
          .prepare(
            `SELECT e.execution_id, e.workspace_id, state.episode_json,
                        e.settlement_kind, e.settlement_json,
                        t.provider_turn_id, t.finish_reason,
                        a.attempt_no, a.outcome, a.provider_error_kind,
                        a.failure_taxonomy_version, a.retry_decision,
                        a.settled_at
                   FROM executions e
                   LEFT JOIN agent_execution_state state ON state.execution_id = e.execution_id
                   LEFT JOIN provider_turns t ON t.execution_id = e.execution_id
                   LEFT JOIN provider_attempts a ON a.provider_turn_id = t.provider_turn_id
                  WHERE e.project_id = ?
                  ORDER BY e.execution_id, t.provider_turn_id, a.attempt_no`,
          )
          .all(project.projectId) as Array<{
          execution_id: string;
          workspace_id: string;
          episode_json: string | null;
          settlement_kind: string | null;
          settlement_json: string | null;
          provider_turn_id: string | null;
          finish_reason: string | null;
          attempt_no: number | null;
          outcome: string | null;
          provider_error_kind: string | null;
          failure_taxonomy_version: string | null;
          retry_decision: string | null;
          settled_at: string | null;
        }>;
      } finally {
        db.close();
      }
    })();
    const terminalEvidence = terminalProviderEvidence.filter((row) => {
      if (row.episode_json === null) return false;
      const episode = JSON.parse(row.episode_json) as {
        _tag?: string;
        workId?: string;
      };
      return (
        episode._tag === "WorkEpisode" &&
        episode.workId === terminalProviderRow.workId
      );
    });
    expect(terminalEvidence).toHaveLength(1);
    expect(terminalEvidence[0]).toMatchObject({
      workspace_id: terminalProviderRow.targetWorkspaceId,
      settlement_kind: "Failed",
      settlement_json: expect.stringContaining(
        "ProviderFailure:RequestRejected",
      ),
      finish_reason: "Failed",
      outcome: "TerminalFailure",
      provider_error_kind: "RequestRejected",
      failure_taxonomy_version: "phase1-v2",
      retry_decision: "Stop",
      settled_at: expect.any(String),
    });
    expect(
      attention.rows.filter(
        (row) =>
          row.dedupKey ===
          completed.bindingAttentionFacts[0]?.attention_fact_id,
      ),
    ).toEqual([
      expect.objectContaining({
        source: "AssignWorkTargetBindingFailure",
        severity: "ActionRequired",
        targetWorkspaceId: assignmentParentWorkspaceId,
        // The public summary is intentionally safe/generic; the durable
        // fact/event assertions above retain the exact typed failure code.
        summaryRef: expect.any(String),
      }),
    ]);
    const tree = await waitForPublic(
      () =>
        publicClient.view<{
          nodes: ReadonlyArray<{
            workspaceId: string;
            parentWorkspaceId: string | null;
            subtreeAttention: {
              attention: number;
              actionRequired: number;
            };
          }>;
        }>("responsibility-tree", { projectId: project.projectId }),
      (view) =>
        (view.nodes.find(
          (node) => node.workspaceId === assignmentParentWorkspaceId,
        )?.subtreeAttention.actionRequired ?? 0) >= 1,
    );
    expect(
      tree.nodes.find(
        (node) => node.workspaceId === terminalProviderRow.targetWorkspaceId,
      )?.parentWorkspaceId,
    ).toBe(assignmentParentWorkspaceId);
    expect(
      tree.nodes.find(
        (node) => node.workspaceId === terminalProviderRow.targetWorkspaceId,
      )?.subtreeAttention,
    ).toMatchObject({ attention: 0, actionRequired: 1 });
    expect(
      tree.nodes.find(
        (node) => node.workspaceId === assignmentParentWorkspaceId,
      )?.subtreeAttention,
    ).toMatchObject({ attention: 0, actionRequired: 2 });
    expect(
      tree.nodes.find((node) => node.workspaceId === project.rootWorkspaceId)
        ?.subtreeAttention.actionRequired,
    ).toBe(2);
  } else {
    expect(observation).toHaveLength(1);
    expect(observation[0]?.status, JSON.stringify(observation[0])).toBe(
      "Succeeded",
    );
    expect(completed.bindingAttentionFacts).toHaveLength(0);
    expect(completed.bindingAttentionEvents).toHaveLength(0);
  }
  if (crashSide === "legacy-unbound" || crashSide === "legacy-p32-upgrade") {
    expect(completed.assignWorkTargetBindings).toHaveLength(0);
  } else {
    expect(completed.assignWorkTargetBindings).toHaveLength(1);
  }
  if (
    crashSide === "corrupt-sibling" ||
    crashSide === "attention-before" ||
    crashSide === "attention-after"
  ) {
    expect(completed.assignWorkTargetBindings[0]?.target_workspace_id).toBe(
      siblingWorkspaceId,
    );
  }
  if (crashSide === "retired-after-commit") {
    expect(
      completed.workspaceLifecycles.find(
        (workspace) => workspace.workspace_id === childWorkspaceId,
      )?.lifecycle,
    ).toBe("Retired");
    expect(observation).toHaveLength(1);
  }
  if (crashSide === "grant-revoked-after-commit") {
    expect(
      completed.permissionGrants.find(
        (grant) => grant.permission_grant_id === assignmentGrantId,
      )?.state,
    ).toBe("Revoked");
    expect(observation).toHaveLength(1);
  }
  expect(
    completed.providerAttempts.filter(
      (attempt) => attempt.provider_turn_id === providerTurnId,
    ),
  ).toEqual([expect.objectContaining({ outcome: "Success", attempt_no: 0 })]);
  expect(listWorkspaceCalls).toHaveLength(1);
  expect(assignWorkCalls).toHaveLength(1);
  const exactApprovals = completed.approvals.filter(
    (approval) => approval.target_ref === targetWorkspaceRef,
  );
  if (
    crashSide === "approval-committed" ||
    crashSide === "approval-fencing-before"
  ) {
    expect(exactApprovals).toHaveLength(1);
    expect(exactApprovals[0]).toMatchObject({
      state: "Consumed",
      consumed_by: committed[0]?.command_id,
    });
  } else {
    expect(exactApprovals).toHaveLength(0);
  }
  expect(fixture.daemonErrors).toEqual([]);
  expect(newDaemon.daemonErrors).toEqual([]);
  expect(resultDaemon.daemonErrors).toEqual([]);
  releaseGate(fixture, "new", "action-result");
  await resultDaemon.crash();
};
