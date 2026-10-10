import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
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
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 AgentLoop and P4 tool intent process crash", () => {
  for (const boundary of [
    "AH7AfterActionIntentCommit",
    "AH7AfterToolIntentCommit",
    "AH7AfterToolSettlementCommit",
    "AH7AfterActionResultCommit",
  ] as const) {
    it(`reuses the same action and tool identity after ${boundary}`, async () => {
      const marker = `AH7-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let targetProviderCalls = 0;
      let probeArmed = false;
      let latestToolResult = "<none>";
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const context = JSON.stringify(call.messages);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          const targetWorkTurn = available.has("read");
          if (context.includes(marker) && targetWorkTurn) {
            if (!probeArmed) {
              return { _tag: "HttpError", status: 503 };
            }
            targetProviderCalls += 1;
            latestToolResult =
              [...call.messages]
                .reverse()
                .find((message) => message.role === "tool")?.content ??
              "<no tool result in request>";
            if (targetProviderCalls > 5) {
              return { _tag: "HttpError", status: 429 };
            }
          }
          if (
            context.includes(marker) &&
            available.has("assign_work") &&
            !targetWorkTurn &&
            !context.includes("WorkAssigned(")
          ) {
            return {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Read proof.txt for ${marker}.`,
                why: "qualify action intent recovery before P4 ToolRuntime",
                constraints: [],
                completionExpectation: "the Agent has observed proof.txt",
                verificationMission: {
                  goal: `Verify the read result for ${marker}`,
                  criteria: [
                    {
                      criterionId: "proof-read",
                      requirement: "proof.txt contains FUNCTIONAL_VERIFIED",
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "AH7 functional test",
              },
            };
          }
          if (context.includes(marker) && targetWorkTurn) {
            const readResult = call.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content?.includes("FUNCTIONAL_VERIFIED") === true,
            );
            return readResult
              ? { _tag: "Text", text: `Read evidence for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "read",
                  arguments: {
                    target: { mount: "workspace", path: "proof.txt" },
                    limit: 200,
                  },
                };
          }
          return { _tag: "Text", text: `Waiting for Work ${marker}` };
        },
        onDaemonStdout: (line) => {
          daemonOutput.push(line);
          recordAhProbeLine(hits, line);
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH7 Pending action intent",
        { resourceSelection: "Profile" },
      );
      await submitHumanMessage(
        client,
        project,
        `请创建并执行一个读取 proof.txt 的目标 ${marker}`,
      );
      const approval = await waitForApproval(client, project, marker).catch(
        (error: unknown) => {
          throw new Error(
            `AH7 public Work approval absent: ${error instanceof Error ? error.message : String(error)}; provider=${JSON.stringify(fixture.providerCalls)}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        },
      );
      expect(
        await client.view("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      ).toBeNull();

      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH7 public Work admission",
      });
      const currentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            status: string;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) => value?.workId !== undefined,
      );
      expect(currentWork).toMatchObject({
        objective: expect.stringContaining(marker),
        status: "Open",
      });
      // Keep the seed conversation outside the AH7 probe. If the normal daemon
      // reaches the new Work first, the fake provider returns a transport
      // failure (never a ToolCall/P4 effect); killing it now lets recovery
      // redispatch the same Open Work under the selected probe.
      await fixture.crash();
      probeArmed = true;
      const targetProviderCallStart = fixture.providerCalls.length;
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });

      const observed = await waitForPublic(
        async () => ({ hits, targetProviderCalls }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.targetProviderCalls >= 5,
        15_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH7 Pending-action probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (!observed.hits.some((candidate) => candidate.boundary === boundary)) {
        await fixture.crash();
        throw new Error(
          `AH7 provider-call cap reached before action-intent probe; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; calls=${JSON.stringify(fixture.providerCalls.slice(-2))}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      const hit = observed.hits.find(
        (candidate) => candidate.boundary === boundary,
      );
      expect(hit).toMatchObject({
        executionId: expect.stringMatching(/^exe_/u),
        callRef: expect.any(String),
        ...(boundary === "AH7AfterActionIntentCommit" ||
        boundary === "AH7AfterActionResultCommit"
          ? {
              providerTurnId: expect.stringMatching(/^ptn_/u),
              logicalActionId: expect.stringMatching(/^lac_/u),
              actionIndex: 0,
            }
          : { invocationId: expect.stringMatching(/^tin_/u) }),
      });

      await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      const targetSteps = crashed.steps.filter(
        (step) => step.execution_id === hit?.executionId,
      );
      const targetActions = crashed.actions.filter(
        (action) => action.execution_id === hit?.executionId,
      );
      const targetInvocations = crashed.toolInvocations.filter(
        (invocation) => invocation.execution_id === hit?.executionId,
      );
      const targetToolResults = crashed.toolResults.filter((result) =>
        JSON.stringify(result).includes(hit?.callRef ?? ""),
      );
      const targetInvocationId = targetInvocations[0]?.invocation_id;
      const targetArtifacts = crashed.artifacts.filter(
        (artifact) => artifact.invocation_id === targetInvocationId,
      );
      expect(targetSteps).toEqual([
        expect.objectContaining({
          execution_id: hit?.executionId,
          provider_turn_id:
            boundary === "AH7AfterActionIntentCommit"
              ? hit?.providerTurnId
              : expect.stringMatching(/^ptn_/u),
          state: "ActionsInProgress",
          next_action_index: boundary === "AH7AfterActionResultCommit" ? 1 : 0,
        }),
      ]);
      expect(targetActions).toEqual([
        expect.objectContaining({
          execution_id: hit?.executionId,
          action_index: 0,
          logical_action_id: expect.stringMatching(/^lac_/u),
          call_ref: hit?.callRef,
          action_kind: "read",
          state:
            boundary === "AH7AfterActionResultCommit" ? "Applied" : "Pending",
        }),
      ]);
      expect(targetInvocations).toEqual(
        boundary === "AH7AfterActionIntentCommit"
          ? []
          : [
              expect.objectContaining({
                execution_id: hit?.executionId,
                tool_name: "read",
                side_effect_semantics: "ReadOnly",
                settled_at:
                  boundary === "AH7AfterToolSettlementCommit" ||
                  boundary === "AH7AfterActionResultCommit"
                    ? expect.any(String)
                    : null,
              }),
            ],
      );
      expect(targetToolResults).toHaveLength(
        boundary === "AH7AfterActionResultCommit" ? 1 : 0,
      );
      if (
        boundary === "AH7AfterToolSettlementCommit" ||
        boundary === "AH7AfterActionResultCommit"
      ) {
        expect(targetArtifacts).toHaveLength(1);
      } else {
        expect(targetArtifacts).toEqual([]);
      }
      const logicalActionId = (
        targetActions[0] as { logical_action_id?: string } | undefined
      )?.logical_action_id;
      if (logicalActionId === undefined) {
        throw new Error("AH7 committed action identity absent");
      }

      await fixture.restart();
      const recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.actions.some(
            (action) =>
              action.logical_action_id === logicalActionId &&
              action.state === "Applied",
          ) &&
          value.toolInvocations.some(
            (invocation) =>
              invocation.execution_id === hit?.executionId &&
              invocation.tool_name === "read" &&
              invocation.settled_at !== null,
          ) &&
          (boundary !== "AH7AfterActionResultCommit" ||
            value.steps.some(
              (step) =>
                step.execution_id === hit?.executionId &&
                step.state !== "ActionsInProgress",
            )),
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH7 restart did not resume the committed Pending action: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      const recoveredTargetActions = recovered.actions.filter(
        (action) => action.execution_id === hit?.executionId,
      );
      const recoveredTargetInvocations = recovered.toolInvocations.filter(
        (invocation) => invocation.execution_id === hit?.executionId,
      );
      const recoveredTargetToolResults = recovered.toolResults.filter(
        (result) => JSON.stringify(result).includes(hit?.callRef ?? ""),
      );
      const recoveredTargetArtifacts = recovered.artifacts.filter(
        (artifact) => artifact.invocation_id === targetInvocationId,
      );
      expect(recoveredTargetActions).toEqual([
        expect.objectContaining({
          execution_id: hit?.executionId,
          action_index: 0,
          logical_action_id: logicalActionId,
          call_ref: hit?.callRef,
          action_kind: "read",
          state: "Applied",
          result_ref: expect.stringMatching(/^result_/u),
          observation_source_ref: expect.stringMatching(/^observation_/u),
        }),
      ]);
      expect(recoveredTargetInvocations).toEqual([
        expect.objectContaining({
          execution_id: hit?.executionId,
          tool_name: "read",
          side_effect_semantics: "ReadOnly",
          settlement_kind: "Success",
          result_ref: expect.any(String),
        }),
      ]);
      if (targetInvocationId !== undefined) {
        expect(recoveredTargetInvocations[0]?.invocation_id).toBe(
          targetInvocationId,
        );
      }
      expect(recoveredTargetToolResults).toHaveLength(1);
      if (
        boundary === "AH7AfterToolSettlementCommit" ||
        boundary === "AH7AfterActionResultCommit"
      ) {
        expect(recoveredTargetArtifacts).toEqual(targetArtifacts);
        expect(recoveredTargetInvocations).toEqual(targetInvocations);
      }
      expect(recoveredTargetToolResults[0]).toMatchObject({
        source_kind: "AgentLoopAction",
      });
      expect(
        JSON.stringify(recoveredTargetToolResults[0]).includes(
          hit?.callRef ?? "",
        ),
      ).toBe(true);
      expect(
        fixture.providerCalls
          .slice(targetProviderCallStart)
          .filter(
            (call) =>
              JSON.stringify(call.messages).includes(marker) &&
              call.tools.some((tool) => tool.function?.name === "read") &&
              !call.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.content?.includes("FUNCTIONAL_VERIFIED") === true,
              ),
          ),
      ).toHaveLength(1);
      expect(fixture.daemonErrors).toEqual([]);
    }, 120_000);
  }
});
