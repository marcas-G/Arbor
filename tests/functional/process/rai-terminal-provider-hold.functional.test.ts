import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const toolNames = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

type TerminalFailureKind =
  | "AuthenticationFailed"
  | "RequestRejected"
  | "ProtocolViolation";

const TERMINAL_PROVIDER_SUMMARY =
  "The model provider rejected this Work execution. Review the provider configuration or request compatibility, then explicitly steer the Work to retry.";

const terminalFailureResponse = (
  failureKind: TerminalFailureKind,
): ScriptedProviderResponse => {
  switch (failureKind) {
    case "AuthenticationFailed":
      return { _tag: "HttpError", status: 401 };
    case "RequestRejected":
      return { _tag: "HttpError", status: 400 };
    case "ProtocolViolation":
      return {
        _tag: "ToolCall",
        name: "claim_completion",
        arguments: undefined,
      };
  }
};

const matchingWorkProviderCalls = (
  calls: ReadonlyArray<CapturedProviderCall>,
  marker: string,
) =>
  calls.filter(
    (call) =>
      toolNames(call).has("claim_completion") &&
      serialized(call).includes(marker),
  );

const executionSnapshot = (
  databaseFile: string,
  workId: string,
  revision: number,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT execution_id, settlement_kind, settlement_json
           FROM executions
          WHERE episode_kind = 'WorkEpisode'
            AND episode_ref = ? AND episode_revision = ?
          ORDER BY admitted_at, execution_id`,
      )
      .all(workId, revision) as Array<{
      execution_id: string;
      settlement_kind: string | null;
      settlement_json: string | null;
    }>;
  } finally {
    db.close();
  }
};

const terminalChainSnapshot = (databaseFile: string, workId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      executions: db
        .prepare(
          "SELECT execution_id, session_id, settlement_kind, settlement_json, settled_at FROM executions WHERE episode_ref = ? ORDER BY admitted_at, execution_id",
        )
        .all(workId),
      steps: db
        .prepare(
          "SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id, manifest_id, state, settlement_json FROM agent_loop_steps WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?) ORDER BY execution_id, logical_step_no, repair_attempt",
        )
        .all(workId),
      turns: db
        .prepare(
          "SELECT provider_turn_id, execution_id, session_id, manifest_id, settled_at, finish_reason, output_contract_ref FROM provider_turns WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?) ORDER BY provider_turn_id",
        )
        .all(workId),
      manifests: db
        .prepare(
          "SELECT manifest_id, provider_turn_id, execution_id, session_id, compiled_request_hash, manifest_json FROM model_context_manifests WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?) ORDER BY manifest_id",
        )
        .all(workId),
      attempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, settled_at, outcome, provider_error_kind, failure_taxonomy_version, retry_decision FROM provider_attempts WHERE provider_turn_id IN (SELECT provider_turn_id FROM provider_turns WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?)) ORDER BY provider_turn_id, attempt_no",
        )
        .all(workId),
    };
  } finally {
    db.close();
  }
};

const projectMutationGuardSnapshot = (
  databaseFile: string,
  projectId: string,
  workspaceId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      projectConfiguration: db
        .prepare(
          "SELECT project_policy, project_policy_revision, default_configuration, environment_ref FROM projects WHERE project_id = ?",
        )
        .get(projectId),
      workspaceBoundary: db
        .prepare(
          "SELECT resource_boundary, resource_boundary_revision, agent_binding, workspace_policy, workspace_policy_revision FROM workspaces WHERE workspace_id = ? AND project_id = ?",
        )
        .get(workspaceId, projectId),
      permissionGrants: db
        .prepare(
          "SELECT * FROM permission_grants WHERE project_id = ? ORDER BY permission_grant_id",
        )
        .all(projectId),
      resourceOwnership: db
        .prepare(
          "SELECT * FROM resource_ownership WHERE workspace_id = ? ORDER BY claim_id",
        )
        .all(workspaceId),
      sandboxDecisions: db
        .prepare(
          "SELECT * FROM sandbox_policy_decisions WHERE project_id = ? ORDER BY workspace_id, execution_id, policy_revision",
        )
        .all(projectId),
    };
  } finally {
    db.close();
  }
};

const prohibitedWorkMutationSnapshot = (
  databaseFile: string,
  workId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      work: db
        .prepare("SELECT lifecycle, revision FROM works WHERE work_id = ?")
        .get(workId),
      workWaits: db
        .prepare("SELECT COUNT(*) AS count FROM work_waits WHERE work_id = ?")
        .get(workId),
      timers: db
        .prepare(
          "SELECT COUNT(*) AS count FROM scheduler_timers WHERE work_id = ?",
        )
        .get(workId),
      verifications: db
        .prepare(
          "SELECT COUNT(*) AS count FROM verifications WHERE work_id = ?",
        )
        .get(workId),
      acceptances: db
        .prepare(
          "SELECT COUNT(*) AS count FROM work_acceptances WHERE work_id = ?",
        )
        .get(workId),
    };
  } finally {
    db.close();
  }
};

const expectNoForbiddenWorkMutation = (
  snapshot: ReturnType<typeof prohibitedWorkMutationSnapshot>,
) => {
  expect(snapshot).toEqual({
    work: { lifecycle: "Open", revision: 0 },
    workWaits: { count: 0 },
    timers: { count: 0 },
    verifications: { count: 0 },
    acceptances: { count: 0 },
  });
};

const expectNoCanaryLeak = (
  canary: string,
  surfaces: ReadonlyArray<unknown>,
) => {
  const leaked = surfaces.some((surface) =>
    JSON.stringify(surface).includes(canary),
  );
  expect(leaked).toBe(false);
};

const terminalFailureProvider =
  (
    marker: string,
    failureKind: TerminalFailureKind,
  ): ((call: CapturedProviderCall) => ScriptedProviderResponse) =>
  (call) => {
    const tools = toolNames(call);
    const context = serialized(call);
    if (tools.has("claim_completion")) {
      return terminalFailureResponse(failureKind);
    }
    if (tools.has("assign_work") && context.includes(marker)) {
      return context.includes("WorkAssigned(")
        ? { _tag: "Text", text: `Work admitted for ${marker}` }
        : {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              objective: `Complete ${marker}.`,
              why: "qualify terminal Provider failure readmission hold",
              constraints: ["no external side effects"],
              completionExpectation: "the Provider failure is held once",
              verificationMission: {
                goal: `Verify ${marker}`,
                criteria: [
                  {
                    criterionId: "rai-terminal-hold",
                    requirement: "same Work revision is not readmitted",
                    required: true,
                  },
                ],
                riskRequirements: ["no repeated Provider request"],
              },
              reason: "RAI-DG-02 functional qualification",
            },
          };
    }
    return { _tag: "Text", text: `Observed ${marker}` };
  };

describe("RAI-DG-02 terminal Provider failure hold", () => {
  for (const failureKind of [
    "AuthenticationFailed",
    "RequestRejected",
    "ProtocolViolation",
  ] as const) {
    it(`holds the first ${failureKind} Work revision across scheduler ticks and restart until Steer`, async () => {
      const marker = `RAI-DG-02-${failureKind}-${crypto.randomUUID().slice(0, 8)}`;
      const sensitiveCanary = `SENSITIVE-RAI-CANARY-${crypto.randomUUID()}`;
      const daemonStdout: string[] = [];
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        reply: terminalFailureProvider(marker, failureKind),
        onDaemonStdout: (line) => daemonStdout.push(line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `RAI terminal Provider hold ${failureKind}`,
      );
      const projectMutationBaseline = projectMutationGuardSnapshot(
        fixture.databaseFile,
        project.projectId,
        project.rootWorkspaceId,
      );

      await submitHumanMessage(
        client,
        project,
        `Create ${marker}. Private prompt material: ${sensitiveCanary}`,
      );
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "qualify exact terminal failure hold",
      });

      const current = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (value) => value?.workId !== undefined,
      );
      const workId = current?.workId;
      if (workId === undefined) throw new Error("RAI WorkId missing");

      const failed = await waitForPublic(
        async () => executionSnapshot(fixture.databaseFile, workId, 0),
        (rows) =>
          rows.length === 1 &&
          rows[0]?.settlement_kind === "Failed" &&
          rows[0]?.settlement_json?.includes(
            `ProviderFailure:${failureKind}`,
          ) === true,
        60_000,
      );
      expect(failed).toHaveLength(1);

      const heldChain = terminalChainSnapshot(fixture.databaseFile, workId);
      expect(heldChain.executions).toHaveLength(1);
      expect(heldChain.turns).toEqual([
        expect.objectContaining({ finish_reason: "Failed" }),
      ]);
      expect(heldChain.attempts).toEqual([
        expect.objectContaining({
          attempt_no: 0,
          outcome: "TerminalFailure",
          provider_error_kind: failureKind,
          failure_taxonomy_version: "phase1-v2",
          retry_decision: "Stop",
        }),
      ]);
      expect(
        matchingWorkProviderCalls(fixture.providerCalls, marker),
      ).toHaveLength(1);
      expectNoForbiddenWorkMutation(
        prohibitedWorkMutationSnapshot(fixture.databaseFile, workId),
      );
      expect(
        projectMutationGuardSnapshot(
          fixture.databaseFile,
          project.projectId,
          project.rootWorkspaceId,
        ),
      ).toEqual(projectMutationBaseline);

      const attention = await waitForPublic(
        () =>
          client.view<{
            rows: Array<{
              source: string;
              severity: string;
              targetWorkspaceId: string;
              dedupKey: string;
              summaryRef: string;
              occurredAt: string;
              terminalProviderFailure?: {
                kind: string;
                workId: string;
                workRevision: number;
                occurredAt: string;
                failureCode: string;
              };
            }>;
          }>("attention", { projectId: project.projectId }),
        (value) =>
          value.rows.some(
            (row) =>
              row.source === "TerminalProviderFailure" &&
              row.terminalProviderFailure?.workId === workId &&
              row.terminalProviderFailure.workRevision === 0,
          ),
      ).catch((error: unknown) => {
        throw new Error(
          `terminal Provider Attention unavailable; cause=${error instanceof Error ? error.message : String(error)}; chain=${JSON.stringify(terminalChainSnapshot(fixture.databaseFile, workId))}; daemon=${JSON.stringify(fixture.daemonErrors)}`,
        );
      });
      const terminalAttention = attention.rows.find(
        (row) => row.source === "TerminalProviderFailure",
      );
      expect(terminalAttention).toMatchObject({
        source: "TerminalProviderFailure",
        severity: "ActionRequired",
        targetWorkspaceId: project.rootWorkspaceId,
        summaryRef: TERMINAL_PROVIDER_SUMMARY,
        terminalProviderFailure: {
          kind: "TerminalProviderFailure",
          workId,
          workRevision: 0,
          failureCode: failureKind,
        },
      });
      expect(terminalAttention?.dedupKey).toMatch(
        new RegExp(`^terminal-provider-failure:${workId}:0:[0-9a-f]{64}$`, "u"),
      );
      expect(terminalAttention?.occurredAt).toBe(
        terminalAttention?.terminalProviderFailure?.occurredAt,
      );

      const detail = await client.view<{
        workId: string;
        lifecycle: string;
        revision: number;
        terminalProviderFailure?: {
          kind: string;
          workId: string;
          workRevision: number;
          occurredAt: string;
          failureCode: string;
        };
      }>("work-detail", {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId,
      });
      expect(detail).toMatchObject({
        workId,
        lifecycle: "Open",
        revision: 0,
        terminalProviderFailure: {
          kind: "TerminalProviderFailure",
          workId,
          workRevision: 0,
          failureCode: failureKind,
        },
      });
      expect(detail.terminalProviderFailure).toMatchObject({
        workRevision: 0,
        failureCode: failureKind,
      });
      expect(detail.terminalProviderFailure?.occurredAt).toBe(
        terminalAttention?.occurredAt,
      );
      expectNoCanaryLeak(sensitiveCanary, [
        attention,
        detail,
        daemonStdout,
        fixture.daemonErrors,
      ]);

      const providerCallsAtHold = fixture.providerCalls.length;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
      expect(executionSnapshot(fixture.databaseFile, workId, 0)).toHaveLength(
        1,
      );
      expect(fixture.providerCalls).toHaveLength(providerCallsAtHold);
      expect(
        matchingWorkProviderCalls(fixture.providerCalls, marker),
      ).toHaveLength(1);
      expect(
        terminalChainSnapshot(fixture.databaseFile, workId).attempts,
      ).toHaveLength(1);
      expectNoForbiddenWorkMutation(
        prohibitedWorkMutationSnapshot(fixture.databaseFile, workId),
      );
      expect(
        projectMutationGuardSnapshot(
          fixture.databaseFile,
          project.projectId,
          project.rootWorkspaceId,
        ),
      ).toEqual(projectMutationBaseline);
      expectNoCanaryLeak(sensitiveCanary, [
        attention,
        detail,
        daemonStdout,
        fixture.daemonErrors,
      ]);

      await fixture.crash();
      await fixture.restart();
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
      expect(executionSnapshot(fixture.databaseFile, workId, 0)).toHaveLength(
        1,
      );
      expect(fixture.providerCalls).toHaveLength(providerCallsAtHold);
      expect(
        matchingWorkProviderCalls(fixture.providerCalls, marker),
      ).toHaveLength(1);
      expect(
        terminalChainSnapshot(fixture.databaseFile, workId).attempts,
      ).toHaveLength(1);
      expectNoForbiddenWorkMutation(
        prohibitedWorkMutationSnapshot(fixture.databaseFile, workId),
      );
      expect(
        projectMutationGuardSnapshot(
          fixture.databaseFile,
          project.projectId,
          project.rootWorkspaceId,
        ),
      ).toEqual(projectMutationBaseline);
      expectNoCanaryLeak(sensitiveCanary, [
        attention,
        detail,
        daemonStdout,
        fixture.daemonErrors,
      ]);

      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: {
          severity: "Normal",
          guidance: `Retry ${marker} only after this explicit revision advance.`,
        },
        provenance: { source: "HumanInput" },
      });
      const revised = await waitForPublic(
        () =>
          client.view<{ workId?: string; revision: number } | null>(
            "current-work",
            { workspaceId: project.rootWorkspaceId },
          ),
        (value) => value?.workId === workId && value.revision === 1,
      );
      expect(revised?.revision).toBe(1);
      await waitForPublic(
        async () => executionSnapshot(fixture.databaseFile, workId, 1),
        (rows) => rows.length === 1,
      );
      expect(executionSnapshot(fixture.databaseFile, workId, 0)).toHaveLength(
        1,
      );
      expect(fixture.daemonErrors).toEqual([]);
    }, 180_000);
  }
});
