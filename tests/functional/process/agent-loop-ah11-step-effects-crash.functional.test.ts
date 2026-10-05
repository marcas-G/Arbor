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
const boundaries = [
  "AH11BeforeStepEffectsCommit",
  "AH11AfterStepEffectsCommit",
] as const;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH11 Observation to StepEffectsCommitted process crash", () => {
  it.each(boundaries)(
    "%s preserves one action Observation and resumes one successor",
    async (boundary) => {
      const marker = `AH11-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let targetProviderCalls = 0;
      const fixture = await startProductionFixture({
        reply: (call) => {
          if (JSON.stringify(call.messages).includes(marker)) {
            targetProviderCalls += 1;
            if (targetProviderCalls > 5) {
              return { _tag: "HttpError", status: 429 };
            }
          }
          const hasRead = call.tools.some(
            (tool) => tool.function?.name === "read",
          );
          if (
            hasRead &&
            !call.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content?.includes("FUNCTIONAL_VERIFIED") === true,
            )
          ) {
            return {
              _tag: "ToolCall",
              name: "read",
              arguments: {
                target: { mount: "workspace", path: "proof.txt" },
                limit: 200,
              },
            };
          }
          return { _tag: "Text", text: `Read evidence for ${marker}` };
        },
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
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
        `AH11 step effects ${marker}`,
      );
      const workId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: `Read proof.txt for ${marker}.`,
        why: "qualify Observation-to-StepEffectsCommitted crash recovery",
        constraints: [],
        completionExpectation: "proof.txt has been read once",
        verificationMission: {
          goal: `Verify AH11 ${marker}`,
          criteria: [
            {
              criterionId: "ah11-read-proof",
              requirement: "proof.txt contains FUNCTIONAL_VERIFIED",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "AH11 process test" },
        revision: 0,
      });

      const observed = await waitForPublic(
        async () => ({ hits, providerCalls: fixture.providerCalls.length }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.providerCalls >= 5,
        30_000,
      );
      const hit = observed.hits.find(
        (candidate) => candidate.boundary === boundary,
      );
      if (hit === undefined) {
        await fixture.crash();
        throw new Error(
          `AH11 probe absent at ${boundary}; providerCalls=${targetProviderCalls}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }
      expect(hit.providerTurnId).toMatch(/^ptn_/u);
      expect(hit.executionId).toMatch(/^exe_/u);

      await fixture.crash();
      const killed = durableSnapshot(fixture.databaseFile);
      expect(killed.steps).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          logical_step_no: 0,
          provider_turn_id: hit.providerTurnId,
          state:
            boundary === "AH11BeforeStepEffectsCommit"
              ? "ActionsInProgress"
              : "StepEffectsCommitted",
          next_action_index: 1,
        }),
      ]);
      expect(killed.actions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          action_index: 0,
          action_kind: "read",
          state: "Applied",
          result_ref: expect.stringMatching(/^result_/u),
          observation_source_ref: expect.stringMatching(/^observation_/u),
        }),
      ]);
      expect(killed.toolInvocations).toHaveLength(1);
      expect(killed.toolResults).toHaveLength(1);
      expect(killed.artifacts).toHaveLength(1);
      expect(killed.executions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at: null,
        }),
      ]);

      await fixture.restart();
      const recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.steps.some(
            (step) =>
              step.execution_id === hit.executionId &&
              step.logical_step_no === 0 &&
              step.state === "NextStepReady",
          ) &&
          value.steps.some(
            (step) =>
              step.execution_id === hit.executionId &&
              step.logical_step_no === 1,
          ),
        45_000,
      );
      expect(recovered.actions).toEqual(killed.actions);
      expect(recovered.toolInvocations).toEqual(killed.toolInvocations);
      expect(recovered.toolResults).toEqual(killed.toolResults);
      expect(recovered.artifacts).toEqual(killed.artifacts);
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
    },
    120_000,
  );
});
