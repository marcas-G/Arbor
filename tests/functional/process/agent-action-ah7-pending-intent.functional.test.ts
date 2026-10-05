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
  functionalId,
  makePublicClient,
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
      let latestToolResult = "<none>";
      const fixture = await startProductionFixture({
        reply: (call) => {
          if (JSON.stringify(call.messages).includes(marker)) {
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
          const toolNames = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (toolNames.has("read")) {
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
        firstDaemonEntry: crashChild,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: boundary,
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
      );
      const workId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
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
        provenance: { predecessorWorkId: null, reason: "AH7 functional test" },
        revision: 0,
      });

      const observed = await waitForPublic(
        async () => ({ hits, providerCalls: fixture.providerCalls.length }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.providerCalls >= 5,
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
      expect(crashed.steps).toEqual([
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
      expect(crashed.actions).toEqual([
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
      expect(crashed.toolInvocations).toEqual(
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
      expect(crashed.toolResults).toHaveLength(
        boundary === "AH7AfterActionResultCommit" ? 1 : 0,
      );
      if (
        boundary === "AH7AfterToolSettlementCommit" ||
        boundary === "AH7AfterActionResultCommit"
      ) {
        expect(crashed.artifacts).toHaveLength(1);
      } else {
        expect(crashed.artifacts).toEqual([]);
      }
      const logicalActionId = (
        crashed.actions[0] as { logical_action_id?: string } | undefined
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
      expect(recovered.actions).toEqual([
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
      expect(recovered.toolInvocations).toEqual([
        expect.objectContaining({
          execution_id: hit?.executionId,
          tool_name: "read",
          side_effect_semantics: "ReadOnly",
          settlement_kind: "Success",
          result_ref: expect.any(String),
        }),
      ]);
      expect(recovered.toolResults).toHaveLength(1);
      if (
        boundary === "AH7AfterToolSettlementCommit" ||
        boundary === "AH7AfterActionResultCommit"
      ) {
        expect(recovered.artifacts).toEqual(crashed.artifacts);
        expect(recovered.toolInvocations).toEqual(crashed.toolInvocations);
      }
      expect(recovered.toolResults[0]).toMatchObject({
        source_kind: "AgentLoopAction",
      });
      expect(
        JSON.stringify(recovered.toolResults[0]).includes(hit?.callRef ?? ""),
      ).toBe(true);
      expect(
        fixture.providerCalls.filter(
          (call) =>
            JSON.stringify(call.messages).includes(marker) &&
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
