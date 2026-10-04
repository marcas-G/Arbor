import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
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

describe("F07 public human steer", () => {
  it("delivers the revision-bound correction to the next Agent execution", async () => {
    const objectiveMarker = `F07-WORK-${crypto.randomUUID().slice(0, 8)}`;
    const guidanceMarker = `F07-STEER-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = await startProductionFixture({
      reply: (call) => {
        const context = JSON.stringify(call.messages);
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
    const workId = functionalId("wrk");

    await client.command(project.projectId, "AssignWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
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
      provenance: { predecessorWorkId: null, reason: "functional steer" },
      revision: 0,
    });

    await waitForPublic(
      async () => fixture.providerCalls.length,
      (count) => count >= 1,
    );
    const beforeSteer = await client.view<{
      workId?: string;
      revision: number;
      status: string;
    } | null>("current-work", { workspaceId: project.rootWorkspaceId });
    expect(beforeSteer).toMatchObject({
      workId,
      revision: 0,
      status: "Open",
    });
    expect(
      fixture.providerCalls.some((call) =>
        JSON.stringify(call.messages).includes(guidanceMarker),
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
      async () => fixture.providerCalls,
      (calls) =>
        calls.some((call) =>
          JSON.stringify(call.messages).includes(guidanceMarker),
        ),
      30_000,
    );
    expect(fixture.daemonErrors).toEqual([]);
  }, 45_000);
});
