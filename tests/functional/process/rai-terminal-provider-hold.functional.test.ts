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

const terminalFailureProvider =
  (
    marker: string,
  ): ((call: CapturedProviderCall) => ScriptedProviderResponse) =>
  (call) => {
    const tools = toolNames(call);
    const context = serialized(call);
    if (tools.has("claim_completion")) {
      return { _tag: "HttpError", status: 400 };
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
  it("holds the first RequestRejected Work revision across scheduler ticks and restart until Steer", async () => {
    const marker = `RAI-DG-02-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: terminalFailureProvider(marker),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "RAI terminal Provider hold",
    );

    await submitHumanMessage(client, project, `Create ${marker}`);
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
          "ProviderFailure:RequestRejected",
        ) === true,
      60_000,
    );
    expect(failed).toHaveLength(1);

    const attention = await waitForPublic(
      () =>
        client.view<{
          rows: Array<{
            source: string;
            targetWorkspaceId: string;
            failureCode?: string;
            terminalProviderFailure?: {
              workId: string;
              workRevision: number;
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
    expect(
      attention.rows.find((row) => row.source === "TerminalProviderFailure")
        ?.terminalProviderFailure?.failureCode,
    ).toBe("RequestRejected");

    const detail = await client.view<{
      terminalProviderFailure?: {
        workRevision: number;
        failureCode: string;
      };
    }>("work-detail", {
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      workId,
    });
    expect(detail.terminalProviderFailure).toMatchObject({
      workRevision: 0,
      failureCode: "RequestRejected",
    });

    const providerCallsAtHold = fixture.providerCalls.length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
    expect(executionSnapshot(fixture.databaseFile, workId, 0)).toHaveLength(1);
    expect(fixture.providerCalls).toHaveLength(providerCallsAtHold);

    await fixture.crash();
    await fixture.restart();
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
    expect(executionSnapshot(fixture.databaseFile, workId, 0)).toHaveLength(1);
    expect(fixture.providerCalls).toHaveLength(providerCallsAtHold);

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
    expect(executionSnapshot(fixture.databaseFile, workId, 0)).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
