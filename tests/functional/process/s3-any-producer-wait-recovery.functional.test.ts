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

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const exposedTools = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

describe("S3 AnyProducer admission recovery over the public process", () => {
  it("rejects unsupported AnyProducer, commits no Dependency/Wait, and asks for clarification", async () => {
    const marker = `S3-ANY-${crypto.randomUUID().slice(0, 8)}`;
    const objective = `Investigate ${marker} and identify a trustworthy producer.`;
    const safeEvidenceMessage = "No eligible producer evidence exists";
    let assignmentIssued = false;
    let anyProducerAttempted = false;
    let modelObservedRejection = false;
    let clarificationReturned = false;

    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call): ScriptedProviderResponse => {
        const available = exposedTools(call);
        const context = serialized(call);
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          if (context.includes("WorkAssigned(")) {
            return { _tag: "Text", text: `Started ${marker}.` };
          }
          assignmentIssued = true;
          return {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              objective,
              why: "The investigation is bounded to the user's project.",
              constraints: ["Do not invent evidence or external producers."],
              completionExpectation:
                "Report what is known and ask for missing producer information.",
              verificationMission: {
                goal: `Verify the investigation ${marker}`,
                criteria: [
                  {
                    criterionId: "evidence-boundary",
                    requirement:
                      "No dependency is committed without an evidence-backed producer.",
                    required: true,
                  },
                ],
                riskRequirements: [],
              },
              reason: "Create a bounded investigation Work.",
            },
          };
        }
        if (
          available.has("declare_dependency") &&
          context.includes(objective) &&
          !anyProducerAttempted
        ) {
          anyProducerAttempted = true;
          return {
            _tag: "ToolCall",
            name: "declare_dependency",
            arguments: {
              producerBinding: { _tag: "AnyProducer" },
              expectedDeliverable: {
                kind: `missing-evidence-${marker}`,
                requiredArtifactRoles: ["evidence"],
              },
            },
          };
        }
        if (context.includes(safeEvidenceMessage)) {
          modelObservedRejection = true;
          clarificationReturned = true;
          return {
            _tag: "Text",
            text: `I cannot identify a producer for ${marker} from the available project facts. Please name an existing responsible workspace or authorize a concrete producer route.`,
          };
        }
        return { _tag: "Text", text: `Clarification needed for ${marker}.` };
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `S3 AnyProducer ${marker}`,
      { resourceSelection: "ConversationOnly" },
    );

    await submitHumanMessage(
      client,
      project,
      `请调查 ${marker} 并说明可信的生产者是谁；如果项目内没有证据，请向我澄清，不要假定未来一定会有生产者。`,
    );
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "Authorize the bounded investigation Work.",
    });

    await waitForPublic(
      () => Promise.resolve(fixture.providerCalls),
      () => clarificationReturned,
    );
    expect(assignmentIssued).toBe(true);
    expect(anyProducerAttempted).toBe(true);
    expect(modelObservedRejection).toBe(true);
    expect(
      fixture.providerCalls.some((call) =>
        serialized(call).includes(safeEvidenceMessage),
      ),
    ).toBe(true);

    const dependencies = await client.view<{
      readonly rows: ReadonlyArray<{ readonly dependencyId: string }>;
    }>("dependency-view", { projectId: project.projectId });
    expect(dependencies.rows).toEqual([]);
    const tree = await client.view<{
      readonly nodes: ReadonlyArray<{
        readonly currentWork?: { readonly workId?: string };
      }>;
    }>("responsibility-tree", { projectId: project.projectId });
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.currentWork?.workId).toMatch(/^wrk_/u);
  });
});
