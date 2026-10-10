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

const tools = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

describe("release-functional cross-Work Dependency and Deliverable", () => {
  it("F19 produces, delivers and deterministically satisfies a Dependency", async () => {
    const producerMarker = `F19-PRODUCER-${crypto.randomUUID().slice(0, 8)}`;
    const consumerMarker = `F19-CONSUMER-${crypto.randomUUID().slice(0, 8)}`;
    let workspacePath = "";
    const reply = (call: CapturedProviderCall): ScriptedProviderResponse => {
      const available = tools(call);
      const context = serialized(call);
      const latestUser = [...call.messages]
        .reverse()
        .find((message) => message.role === "user")?.content;

      if (
        available.has("propose_workspace") &&
        !available.has("claim_completion") &&
        latestUser?.includes(producerMarker) === true
      ) {
        return context.includes("ProposalRecorded(")
          ? { _tag: "Text", text: `Producer proposed ${producerMarker}` }
          : {
              _tag: "ToolCall",
              name: "propose_workspace",
              arguments: {
                name: `producer-${producerMarker}`,
                rationale: "formal cross-work producer",
                responsibilityDraft: {
                  purpose: `produce ${producerMarker}`,
                  ownedResponsibilities: [producerMarker],
                  obligations: ["produce and deliver formal results"],
                  includes: [],
                  excludes: [],
                  interfaces: [],
                },
                resourceBoundaryDraft: {
                  addresses: [{ _tag: "FileTree", path: workspacePath }],
                },
                initialWork: {
                  objective: `Produce ${producerMarker}.`,
                  why: "functional dependency producer",
                  constraints: ["read-only source inspection"],
                  completionExpectation: "formal delivered report",
                  verificationMission: {
                    goal: `Verify ${producerMarker}`,
                    criteria: [
                      {
                        criterionId: "producer-result",
                        requirement: "formal report is delivered",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                },
              },
            };
      }

      if (
        available.has("claim_completion") &&
        context.includes(`objective: Produce ${producerMarker}`)
      ) {
        const artifactId = /art_[0-9a-f-]{36}/u.exec(context)?.[0];
        const deliverableId = /del_[0-9a-f-]{36}/u.exec(context)?.[0];
        if (artifactId === undefined) {
          return {
            _tag: "ToolCall",
            name: "read",
            arguments: {
              target: { mount: "workspace", path: "proof.txt" },
              limit: 200,
            },
          };
        }
        if (deliverableId === undefined) {
          return {
            _tag: "ToolCall",
            name: "produce_deliverable",
            arguments: {
              kind: "functional-report",
              artifacts: [{ role: "result", artifactId }],
            },
          };
        }
        if (!context.includes("DeliverableDelivered(")) {
          return {
            _tag: "ToolCall",
            name: "deliver",
            arguments: {
              deliverableId,
              summary: `Delivered ${producerMarker}`,
            },
          };
        }
        return {
          _tag: "ToolCall",
          name: "wait",
          arguments: {
            reason: "producer delivery complete",
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
          },
        };
      }

      if (
        available.has("assign_work") &&
        !available.has("claim_completion") &&
        latestUser?.includes(consumerMarker) === true
      ) {
        return context.includes("WorkAssigned(")
          ? { _tag: "Text", text: `Consumer started ${consumerMarker}` }
          : {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Consume ${consumerMarker}.`,
                why: "functional dependency consumer",
                constraints: [],
                completionExpectation: "dependency is satisfied",
                verificationMission: {
                  goal: `Verify ${consumerMarker}`,
                  criteria: [
                    {
                      criterionId: "dependency-satisfied",
                      requirement: "formal dependency is satisfied",
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "functional consumer goal",
              },
            };
      }

      if (
        available.has("declare_dependency") &&
        context.includes(`objective: Consume ${consumerMarker}`)
      ) {
        if (!context.includes("DependencyDeclared(")) {
          return {
            _tag: "ToolCall",
            name: "declare_dependency",
            arguments: {
              producerBinding: { _tag: "AnyProducer" },
              expectedDeliverable: {
                kind: "functional-report",
                requiredArtifactRoles: ["result"],
              },
            },
          };
        }
        return {
          _tag: "ToolCall",
          name: "wait",
          arguments: {
            reason: "wait for formal dependency",
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
          },
        };
      }

      return { _tag: "Text", text: "Coordination input observed" };
    };

    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply,
    });
    fixtures.push(fixture);
    workspacePath = fixture.workspaceDirectory;
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F19 cross-Work delivery",
      { resourceSelection: "Profile" },
    );

    await submitHumanMessage(
      client,
      project,
      `请创建长期生产职责 ${producerMarker} 并附带首个生产工作。`,
    );
    const governance = await waitForPublic(
      () =>
        client.view<{
          unconsumed: Array<{ entryKey: string; summary: string }>;
        }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value.unconsumed.some(
          (entry) =>
            entry.summary.includes(producerMarker) &&
            /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
        ),
    );
    const formation = governance.unconsumed.find(
      (entry) =>
        entry.summary.includes(producerMarker) &&
        /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey),
    );
    const formationRef =
      formation === undefined
        ? null
        : /^gov:(fpr_[^:]+):(\d+)$/u.exec(formation.entryKey);
    if (formationRef === null) throw new Error("formation ref missing");
    await client.command(project.projectId, "RecordDecision", {
      proposalId: formationRef[1],
      expectedProposalRevision: Number(formationRef[2]),
      outcome: { _tag: "Approve" },
    });

    await waitForPublic(
      async () =>
        fixture.providerCalls.some((call) =>
          serialized(call).includes("DeliverableDelivered("),
        ),
      (delivered) => delivered,
      45_000,
    );

    await submitHumanMessage(
      client,
      project,
      `请创建消费工作 ${consumerMarker}，它需要 functional-report 的 result。`,
    );
    const approval = await waitForApproval(client, project, consumerMarker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "functional consumer approval",
    });

    let dependency: {
      rows: Array<{
        dependencyId: string;
        state: string;
        satisfiedBy?: string;
      }>;
    };
    try {
      dependency = await waitForPublic(
        () =>
          client.view<{
            rows: Array<{
              dependencyId: string;
              state: string;
              satisfiedBy?: string;
            }>;
          }>("dependency-view", { projectId: project.projectId }),
        (value) =>
          value.rows.some(
            (row) => row.state === "Satisfied" && row.satisfiedBy !== undefined,
          ),
        20_000,
      );
    } catch (error) {
      const currentWork = await client.view("current-work", {
        workspaceId: project.rootWorkspaceId,
      });
      const providerSummary = fixture.providerCalls.map((call) => ({
        tools: [...tools(call)],
        hasConsumer: serialized(call).includes(consumerMarker),
        latestUser: [...call.messages]
          .reverse()
          .find((message) => message.role === "user")?.content,
      }));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; currentWork=${JSON.stringify(currentWork)}; provider=${JSON.stringify(providerSummary)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    }
    expect(dependency.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "Satisfied",
          satisfiedBy: expect.stringMatching(/^del_/u),
        }),
      ]),
    );
    expect(fixture.daemonErrors).toEqual([]);
  }, 90_000);
});
