import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
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

const manualWait = (reason: string): ScriptedProviderResponse => ({
  _tag: "ToolCall",
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
  },
});

const contextOf = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

describe("F19 dependency-first delivery", () => {
  it("keeps consumer asleep until a later child delivery satisfies and wakes it", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const consumerObjective = `Consume F19-WAKE-${marker}`;
    const producerObjective = `Produce F19-WAKE-${marker}`;
    const deliverableKind = `wake-report-${marker}`;
    const childWorkspaceId = functionalId("ws");
    let consumerWaitIssued = false;
    let consumerWoke = false;
    let consumerWakeContext = "";
    const reply = (call: CapturedProviderCall): ScriptedProviderResponse => {
      const context = contextOf(call);
      if (context.includes(consumerObjective)) {
        if (!context.includes("DependencyDeclared(")) {
          return {
            _tag: "ToolCall",
            name: "declare_dependency",
            arguments: {
              producerBinding: {
                _tag: "WorkspaceBound",
                workspaceId: childWorkspaceId,
              },
              expectedDeliverable: {
                kind: deliverableKind,
                requiredArtifactRoles: [],
              },
            },
          };
        }
        if (!consumerWaitIssued) {
          const dependencyId = /dep_[0-9a-f-]{36}/u.exec(context)?.[0];
          if (dependencyId === undefined) {
            throw new Error(
              "declared dependency ID missing from model context",
            );
          }
          consumerWaitIssued = true;
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: "await exact child deliverable",
              waitSpec: {
                mode: "Any",
                conditions: [
                  {
                    _tag: "DependencyChanged",
                    dependencyId,
                    observedRevision: 0,
                  },
                ],
              },
            },
          };
        }
        consumerWoke = true;
        consumerWakeContext = context;
        return manualWait("consumer resumed after dependency change");
      }

      if (context.includes(producerObjective)) {
        const deliverableId = /del_[0-9a-f-]{36}/u.exec(context)?.[0];
        if (deliverableId === undefined) {
          return {
            _tag: "ToolCall",
            name: "produce_deliverable",
            arguments: { kind: deliverableKind, artifacts: [] },
          };
        }
        if (!context.includes("DeliverableDelivered(")) {
          return {
            _tag: "ToolCall",
            name: "deliver",
            arguments: {
              deliverableId,
              summary: `F19 child delivered ${marker}`,
            },
          };
        }
        return manualWait("producer delivery complete");
      }

      return { _tag: "Text", text: "Unexpected unrelated episode" };
    };

    const fixture = await startProductionFixture({ reply });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F19 dependency-first wake",
    );
    await client.command(project.projectId, "CreateChildWorkspace", {
      parentWorkspaceId: project.rootWorkspaceId,
      workspaceId: childWorkspaceId,
      primarySession: { sessionId: functionalId("ses"), contextEpoch: 0 },
      name: `producer-${marker}`,
      responsibilityDefinition: {
        purpose: producerObjective,
        ownedResponsibilities: [producerObjective],
        obligations: ["deliver a formal result"],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceBoundary: { basisResponsibilityRevision: 0, addresses: [] },
      resourceBoundaryRevision: 0,
      agentBinding: {
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: childWorkspaceId,
      },
      workspacePolicy: {},
      workspacePolicyRevision: 0,
      revision: 0,
    });

    const consumerWorkId = functionalId("wrk");
    await client.command(project.projectId, "AssignWork", {
      workId: consumerWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: consumerObjective,
      why: "prove dependency-first waiting and exact wake",
      constraints: [],
      completionExpectation: "child delivery satisfies the dependency",
      verificationMission: {
        goal: "verify dependency-first wake",
        criteria: [
          {
            criterionId: "dependency-wake",
            requirement: "consumer resumes only after child delivery",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "F19 wake test" },
      revision: 0,
    });

    const pending = await waitForPublic(
      () =>
        client.view<{
          rows: Array<{
            dependencyId: string;
            state: string;
            satisfiedBy?: string;
          }>;
        }>("dependency-view", { projectId: project.projectId }),
      (value) =>
        consumerWaitIssued &&
        value.rows.some((row) => row.state === "Unsatisfied"),
    );
    const dependencyId = pending.rows.find(
      (row) => row.state === "Unsatisfied",
    )?.dependencyId;
    expect(dependencyId).toMatch(/^dep_/u);
    await waitForPublic(
      () =>
        client.view<{ activeExecution?: { executionId: string } } | null>(
          "current-work",
          { workspaceId: project.rootWorkspaceId },
        ),
      (value) => value !== null && value.activeExecution === undefined,
    );
    if (consumerWoke) {
      throw new Error(
        `consumer resumed before producer assignment: ${JSON.stringify({
          calls: fixture.providerCalls.map((call) => ({
            tools: call.tools.map((tool) => tool.function?.name),
            hasConsumer: contextOf(call).includes(consumerObjective),
            hasProducer: contextOf(call).includes(producerObjective),
            hasDeclared: contextOf(call).includes("DependencyDeclared("),
            hasSatisfied: contextOf(call).includes("DependencySatisfied("),
            tail: call.messages.slice(-3).map((message) => ({
              role: message.role,
              content: message.content?.slice(-500),
            })),
          })),
          pending,
          daemonErrors: fixture.daemonErrors,
        })}`,
      );
    }
    expect(
      fixture.providerCalls.filter((call) =>
        contextOf(call).includes(consumerObjective),
      ),
    ).toHaveLength(2);

    await client.command(project.projectId, "AssignWork", {
      workId: functionalId("wrk"),
      workspaceId: childWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: producerObjective,
      why: "produce the later child result",
      constraints: [],
      completionExpectation: "formal deliverable is delivered",
      verificationMission: {
        goal: "verify child delivery",
        criteria: [
          {
            criterionId: "child-delivery",
            requirement: "a formal deliverable is delivered",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "F19 wake test" },
      revision: 0,
    });

    const satisfied = await waitForPublic(
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
          (row) =>
            row.dependencyId === dependencyId &&
            row.state === "Satisfied" &&
            row.satisfiedBy?.startsWith("del_") === true,
        ),
      45_000,
    );
    expect(satisfied.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependencyId,
          state: "Satisfied",
          satisfiedBy: expect.stringMatching(/^del_/u),
        }),
      ]),
    );
    await waitForPublic(
      async () => consumerWoke,
      (value) => value,
      30_000,
    );
    const deliveredId = satisfied.rows.find(
      (row) => row.dependencyId === dependencyId,
    )?.satisfiedBy;
    expect(consumerWakeContext).toContain(`Deliver ${deliveredId}`);
    expect(fixture.daemonErrors).toEqual([]);
  }, 90_000);
});
