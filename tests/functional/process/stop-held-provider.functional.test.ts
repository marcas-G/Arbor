import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
  },
});

describe("public StopExecution while Provider is waiting", () => {
  it("interrupts the held Provider request before the Provider responds", async () => {
    const marker = `STOP-HELD-${crypto.randomUUID().slice(0, 8)}`;
    let releaseHeldResponse: (() => void) | undefined;
    let heldProviderResponse = false;
    let heldResponseRelease: Promise<void> | undefined;
    const fixture = await startProductionFixture({
      preserveDirectoryOnStop: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Hold a model turn for ${marker}.`,
                  why: "verify public StopExecution interrupts a live Provider request",
                  constraints: [],
                  completionExpectation: "the held request is stopped",
                  verificationMission: {
                    goal: "verify the held request is stopped",
                    criteria: [
                      {
                        criterionId: "held-request-stopped",
                        requirement:
                          "the current execution becomes inactive after StopExecution",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "held Provider stop qualification",
                },
              };
        }
        return manualWait("held Provider response");
      },
      beforeResponse: async (call) => {
        const context = JSON.stringify(call.messages);
        const isWorkTurn =
          call.tools.some(
            (tool) => tool.function?.name === "claim_completion",
          ) && context.includes(marker);
        if (!isWorkTurn) return undefined;
        heldProviderResponse = true;
        heldResponseRelease = new Promise<void>((resolve) => {
          releaseHeldResponse = resolve;
        });
        await heldResponseRelease;
        return "respond";
      },
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "stop held Provider",
    );
    await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `请创建工作目标 ${marker}，然后等待停止。`,
    );
    await waitForPublic(
      async () => ({
        held: heldProviderResponse,
        current: undefined as
          | { activeExecution?: { executionId: string } }
          | undefined,
      }),
      (value) => value.held,
    );
    const active = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) => value?.activeExecution?.executionId !== undefined,
    );
    const executionId = active?.activeExecution?.executionId;
    if (executionId === undefined)
      throw new Error("held execution disappeared");

    const stopStartedAt = Date.now();
    await client.command(project.projectId, "StopExecution", { executionId });
    let stopped: {
      workId?: string;
      activeExecution?: { executionId: string };
    } | null;
    try {
      stopped = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (value) => value?.activeExecution?.executionId !== executionId,
        10_000,
      );
    } catch (cause) {
      const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
      const row = db
        .prepare(
          "SELECT stop_requested_at, settlement_kind, settled_at FROM executions WHERE execution_id = ?",
        )
        .get(executionId);
      const turns = db
        .prepare(
          "SELECT provider_turn_id, settled_at FROM provider_turns WHERE execution_id = ?",
        )
        .all(executionId);
      const attempts = db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome FROM provider_attempts WHERE provider_turn_id IN (SELECT provider_turn_id FROM provider_turns WHERE execution_id = ?)",
        )
        .all(executionId);
      db.close();
      throw new Error(
        `Stop did not quiesce: ${cause instanceof Error ? cause.message : String(cause)}; row=${JSON.stringify(row)}; turns=${JSON.stringify(turns)}; attempts=${JSON.stringify(attempts)}; directory=${fixture.directory}; daemonErrors=${fixture.daemonErrors.join(" | ")}`,
        { cause },
      );
    }
    expect(stopped?.activeExecution?.executionId).not.toBe(executionId);
    expect(Date.now() - stopStartedAt).toBeLessThan(5_000);
    const settled = await waitForPublic(
      async () => {
        const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
        try {
          const execution = db
            .prepare(
              "SELECT settlement_kind FROM executions WHERE execution_id = ?",
            )
            .get(executionId) as { settlement_kind?: string } | undefined;
          const attempt = db
            .prepare(
              "SELECT outcome FROM provider_attempts WHERE provider_turn_id IN (SELECT provider_turn_id FROM provider_turns WHERE execution_id = ?) ORDER BY attempt_no DESC LIMIT 1",
            )
            .get(executionId) as { outcome?: string } | undefined;
          return {
            settlement: execution?.settlement_kind,
            attempt: attempt?.outcome,
          };
        } finally {
          db.close();
        }
      },
      (value) =>
        value.settlement === "Interrupted" && value.attempt === "Cancelled",
      10_000,
    );
    expect(settled).toEqual({
      settlement: "Interrupted",
      attempt: "Cancelled",
    });

    // Let the provider fixture observe the transport close and finish its
    // request handler. The public stop/settlement assertion above does not
    // depend on this release.
    releaseHeldResponse?.();
    await heldResponseRelease;
  }, 45_000);
});
