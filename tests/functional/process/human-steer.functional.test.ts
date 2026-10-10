import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
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

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
  },
});

describe("F07 public human steer", () => {
  it("delivers the revision-bound correction to the next Agent execution", async () => {
    const objectiveMarker = `F07-WORK-${crypto.randomUUID().slice(0, 8)}`;
    const guidanceMarker = `F07-STEER-${crypto.randomUUID().slice(0, 8)}`;
    let workProviderCalls = 0;
    const fixture = await startProductionFixture({
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
          context.includes(objectiveMarker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${objectiveMarker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Inspect ${objectiveMarker} and wait for correction.`,
                  why: "test whether the next execution receives a user correction",
                  constraints: [],
                  completionExpectation: "correction observed",
                  verificationMission: {
                    goal: "verify correction uptake",
                    criteria: [
                      {
                        criterionId: "correction-visible",
                        requirement: "the Agent receives the user correction",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "functional steer",
                },
              };
        }
        if (
          available.has("claim_completion") &&
          context.includes(objectiveMarker)
        ) {
          workProviderCalls += 1;
        }
        return manualWait(
          context.includes(guidanceMarker)
            ? `observed ${guidanceMarker}`
            : "awaiting user correction",
        );
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F07 correction",
    );
    await submitHumanMessage(
      client,
      project,
      `请创建工作目标 ${objectiveMarker}，等待我随后提供修正。`,
    );
    const approval = await waitForApproval(client, project, objectiveMarker);
    expect(
      await client.view("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    ).toBeNull();
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "F07 public Work admission",
    });
    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          objective: string;
          revision: number;
          status: string;
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (work) => work?.workId !== undefined,
    );
    const workId = currentWork?.workId;
    if (workId === undefined) throw new Error("F07 public Work absent");
    expect(currentWork).toMatchObject({
      objective: `Inspect ${objectiveMarker} and wait for correction.`,
      revision: 0,
      status: "Open",
    });

    await waitForPublic(
      async () => workProviderCalls,
      (count) => count >= 1,
    );
    const beforeSteer = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        work?.workId === workId &&
        work.revision === 0 &&
        work.activeExecution === undefined,
    );
    expect(beforeSteer).toMatchObject({
      workId,
      revision: 0,
      status: "Open",
    });
    expect(
      fixture.providerCalls.some(
        (call) =>
          call.tools.some(
            (tool) => tool.function?.name === "claim_completion",
          ) && JSON.stringify(call.messages).includes(guidanceMarker),
      ),
    ).toBe(false);

    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 0,
      steer: { severity: "Normal", guidance: guidanceMarker },
      provenance: { source: "HumanInput" },
    });

    const revised = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) => work?.workId === workId && work.revision === 1,
    );
    expect(revised?.status).toBe("Open");
    await waitForPublic(
      async () => ({ calls: fixture.providerCalls, workProviderCalls }),
      (value) =>
        value.calls.some(
          (call) =>
            call.tools.some(
              (tool) => tool.function?.name === "claim_completion",
            ) && JSON.stringify(call.messages).includes(guidanceMarker),
        ) && workProviderCalls > 1,
      30_000,
    );
    expect(fixture.daemonErrors).toEqual([]);
  }, 45_000);
});
