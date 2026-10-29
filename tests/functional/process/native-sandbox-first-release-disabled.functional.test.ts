import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("Native Sandbox first-release Disabled default", () => {
  it("omits shell from a real Work model request when no mode is configured", async () => {
    const marker = `native-disabled-${crypto.randomUUID().slice(0, 8)}`;
    const objective = `Inspect Disabled process execution ${marker}.`;
    const workToolSets: string[][] = [];
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined);
        if (
          available.includes("assign_work") &&
          !context.includes("WorkAssigned(")
        ) {
          return {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              objective,
              why: "exercise the real Work model catalog",
              constraints: ["do not run process commands"],
              completionExpectation: "inspect the assigned Work",
              verificationMission: {
                goal: `Verify ${marker}`,
                criteria: [
                  {
                    criterionId: "disabled-shell-hidden",
                    requirement: "the Work model is not offered shell",
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
              reason: "first-release Disabled qualification",
            },
          };
        }
        if (available.includes("claim_completion")) {
          workToolSets.push(available);
          return { _tag: "Text", text: `Observed ${marker}.` };
        }
        return { _tag: "Text", text: `Work request received ${marker}.` };
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `Native Disabled ${marker}`,
      { resourceSelection: "Profile" },
    );
    await submitHumanMessage(client, project, `Create a Work for ${marker}.`);
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
      capability: "core.control.assign-work",
      target: project.rootWorkspaceId,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "Native Sandbox Disabled public qualification",
    });
    await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          objective?: string;
          status: string;
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (work) => work?.objective === objective,
    );
    await waitForPublic(
      async () => workToolSets.length,
      (count) => count > 0,
    );
    expect(workToolSets.length).toBeGreaterThan(0);
    expect(workToolSets.every((tools) => !tools.includes("shell"))).toBe(true);
    expect(fixture.providerCalls.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
