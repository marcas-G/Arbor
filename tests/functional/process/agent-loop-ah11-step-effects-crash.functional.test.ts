import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
let activePhase: string | undefined;
let activeExecutionId: string | undefined;
let activeDiagnosticTimer: ReturnType<typeof setTimeout> | undefined;
let activeDiagnosticWriter: (() => void) | undefined;
const boundaries = [
  "AH11BeforeStepEffectsCommit",
  "AH11AfterStepEffectsCommit",
] as const;

afterEach(async () => {
  if (activeDiagnosticTimer !== undefined) {
    clearTimeout(activeDiagnosticTimer);
    activeDiagnosticTimer = undefined;
  }
  activePhase = "cleanup-started";
  activeDiagnosticWriter?.();
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  activePhase = "cleanup-complete";
  activeDiagnosticWriter?.();
  activeDiagnosticWriter = undefined;
  activePhase = undefined;
  activeExecutionId = undefined;
});

describe("AH11 Observation to StepEffectsCommitted process crash", () => {
  it.each(boundaries)(
    "%s preserves one action Observation and resumes one successor",
    async (boundary) => {
      const marker = `AH11-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let probeArmed = false;
      let seedWorkProviderCalls = 0;
      let targetProviderCalls = 0;
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const context = JSON.stringify(call.messages);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (
            context.includes(marker) &&
            available.has("assign_work") &&
            !available.has("read")
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Work admitted for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
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
                    reason: "AH11 process test",
                  },
                };
          }
          const hasRead = call.tools.some(
            (tool) => tool.function?.name === "read",
          );
          if (hasRead && context.includes(marker)) {
            const hasReadResult = call.messages.some(
              (message) =>
                message.role === "tool" &&
                message.content?.includes("FUNCTIONAL_VERIFIED") === true,
            );
            if (!probeArmed) {
              seedWorkProviderCalls += 1;
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `AH11 setup waits for probe ${marker}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
            if (!hasReadResult) {
              targetProviderCalls += 1;
              if (targetProviderCalls > 5) {
                return { _tag: "HttpError", status: 429 };
              }
              return {
                _tag: "ToolCall",
                name: "read",
                arguments: {
                  target: { mount: "workspace", path: "proof.txt" },
                  limit: 200,
                },
              };
            }
            activePhase = "successor-wait-requested";
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `AH11 read evidence observed for ${marker}`,
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            };
          }
          return { _tag: "Text", text: `Read evidence for ${marker}` };
        },
        onDaemonStdout: (line) => {
          daemonOutput.push(line);
          recordAhProbeLine(hits, line);
        },
      });
      fixtures.push(fixture);
      activePhase = "fixture-ready";
      const diagnosticPath = join(
        process.cwd(),
        ".test-results",
        "ah11-phase-diagnostics",
        `${marker}-${boundary}.ndjson`,
      );
      const writeDiagnostic = () => {
        let snapshot: unknown = "<snapshot unavailable>";
        try {
          const durable = durableSnapshot(fixture.databaseFile);
          snapshot = {
            executions:
              activeExecutionId === undefined
                ? durable.executions.filter(
                    (execution) => execution.settled_at === null,
                  )
                : durable.executions.filter(
                    (execution) => execution.execution_id === activeExecutionId,
                  ),
            steps:
              activeExecutionId === undefined
                ? durable.steps
                : durable.steps.filter(
                    (step) => step.execution_id === activeExecutionId,
                  ),
            actions:
              activeExecutionId === undefined
                ? durable.actions
                : durable.actions.filter(
                    (action) => action.execution_id === activeExecutionId,
                  ),
            toolInvocations:
              activeExecutionId === undefined
                ? []
                : durable.toolInvocations.filter(
                    (invocation) =>
                      invocation.execution_id === activeExecutionId,
                  ),
          };
        } catch (error) {
          snapshot = error instanceof Error ? error.message : String(error);
        }
        const diagnostic = {
          phase: activePhase,
          boundary,
          marker,
          executionId: activeExecutionId ?? null,
          seedWorkProviderCalls,
          targetProviderCalls,
          providerCalls: fixture.providerCalls.slice(-6).map((call) => ({
            tools: call.tools.map((tool) => tool.function?.name),
            messages: call.messages.slice(-3).map((message) => ({
              role: message.role,
              content: message.content?.slice(0, 120),
            })),
          })),
          daemon: fixture.daemonProcessSnapshot(),
          daemonErrors: fixture.daemonErrors,
          snapshot,
        };
        mkdirSync(dirname(diagnosticPath), { recursive: true });
        writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic)}\n`, {
          flag: "a",
        });
        console.error(
          `AH11 phase diagnostic file=${diagnosticPath}: ${JSON.stringify({
            phase: activePhase,
            boundary,
            executionId: activeExecutionId ?? null,
            targetProviderCalls,
            daemon: diagnostic.daemon,
          })}`,
        );
      };
      activeDiagnosticWriter = writeDiagnostic;
      activeDiagnosticTimer = setTimeout(writeDiagnostic, 90_000);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH11 step effects ${marker}`,
        { resourceSelection: "Profile" },
      );
      await submitHumanMessage(
        client,
        project,
        `请创建读取 proof.txt 的目标 ${marker}`,
      );
      activePhase = "root-submitted";
      const approval = await waitForApproval(client, project, marker);
      activePhase = "root-approval-ready";
      expect(
        await client.view("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      ).toBeNull();
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH11 public Work admission",
      });
      activePhase = "work-approved";
      const currentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
            status: string;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (work) => work?.workId !== undefined,
      );
      const workId = currentWork?.workId;
      if (workId === undefined) throw new Error("AH11 public Work absent");
      activePhase = "work-open";
      expect(currentWork).toMatchObject({
        objective: expect.stringContaining(marker),
        revision: 0,
        status: "Open",
      });
      await waitForPublic(
        async () => seedWorkProviderCalls,
        (count) => count >= 1,
      );
      activePhase = "seed-manual-wait";
      await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (work) =>
          work?.workId === workId &&
          work.revision === 0 &&
          work.activeExecution === undefined,
      );
      const seedSnapshot = durableSnapshot(fixture.databaseFile);
      const seedExecutionIds = new Set(
        seedSnapshot.executions.map((execution) => execution.execution_id),
      );
      expect(
        seedSnapshot.executions.every(
          (execution) => execution.settlement_kind !== "Failed",
        ),
      ).toBe(true);

      // The seed Work only enters a legal Manual wait. Install the Observation
      // crash probe before public SteerWork starts the measured read action.
      await fixture.crash();
      activePhase = "seed-daemon-exited";
      probeArmed = true;
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      activePhase = "probe-daemon-ready";
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: {
          severity: "Normal",
          guidance: `AH11 probe armed ${marker}`,
        },
        provenance: { source: "HumanInput" },
      });
      activePhase = "measured-work-steered";

      const observed = await waitForPublic(
        async () => ({ hits, targetProviderCalls }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.targetProviderCalls >= 5,
        30_000,
      );
      const hit = observed.hits.find(
        (candidate) => candidate.boundary === boundary,
      );
      activeExecutionId = hit?.executionId;
      activePhase = "boundary-reached";
      if (hit === undefined) {
        await fixture.crash();
        throw new Error(
          `AH11 probe absent at ${boundary}; providerCalls=${targetProviderCalls}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }
      expect(hit.providerTurnId).toMatch(/^ptn_/u);
      expect(hit.executionId).toMatch(/^exe_/u);
      expect(seedExecutionIds.has(hit.executionId)).toBe(false);

      await fixture.crash();
      activePhase = "probe-daemon-exited";
      const killed = durableSnapshot(fixture.databaseFile);
      activePhase = "kill-snapshot-read";
      const killedTargetSteps = killed.steps.filter(
        (step) => step.execution_id === hit.executionId,
      );
      const killedTargetActions = killed.actions.filter(
        (action) => action.execution_id === hit.executionId,
      );
      const killedTargetInvocations = killed.toolInvocations.filter(
        (invocation) => invocation.execution_id === hit.executionId,
      );
      const killedTargetResults = killed.toolResults.filter((result) =>
        JSON.stringify(result).includes(hit.callRef ?? ""),
      );
      const killedTargetInvocationIds = new Set(
        killedTargetInvocations.map((invocation) => invocation.invocation_id),
      );
      const killedTargetArtifacts = killed.artifacts.filter((artifact) =>
        killedTargetInvocationIds.has(artifact.invocation_id),
      );
      expect(killedTargetSteps).toEqual([
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
      expect(killedTargetActions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          action_index: 0,
          action_kind: "read",
          state: "Applied",
          result_ref: expect.stringMatching(/^result_/u),
          observation_source_ref: expect.stringMatching(/^observation_/u),
        }),
      ]);
      expect(killedTargetInvocations).toHaveLength(1);
      expect(killedTargetResults).toHaveLength(1);
      expect(killedTargetArtifacts).toHaveLength(1);
      expect(
        killed.executions.filter(
          (execution) => execution.execution_id === hit.executionId,
        ),
      ).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at: null,
        }),
      ]);

      activePhase = "pre-restart-snapshot-validated";
      await fixture.restart();
      activePhase = "recovery-daemon-ready";
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
      ).catch((error: unknown) => {
        const latest = durableSnapshot(fixture.databaseFile);
        const latestCalls = fixture.providerCalls.slice(-8).map((call) => ({
          tools: call.tools.map((tool) => tool.function?.name),
          messages: call.messages.slice(-4).map((message) => ({
            role: message.role,
            content: message.content?.slice(0, 160),
          })),
        }));
        throw new Error(
          `AH11 recovery timed out: ${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(
            {
              executionId: hit.executionId,
              steps: latest.steps.filter(
                (step) => step.execution_id === hit.executionId,
              ),
              actions: latest.actions.filter(
                (action) => action.execution_id === hit.executionId,
              ),
              toolInvocations: latest.toolInvocations.filter(
                (invocation) => invocation.execution_id === hit.executionId,
              ),
              providerCalls: fixture.providerCalls.length,
              targetProviderCalls,
              latestCalls,
              daemon: fixture.daemonProcessSnapshot(),
              daemonErrors: fixture.daemonErrors,
            },
          )}`,
        );
      });
      activePhase = "step-effects-committed-successor-ready";
      const recoveredTargetActions = recovered.actions.filter(
        (action) => action.execution_id === hit.executionId,
      );
      const recoveredTargetInvocations = recovered.toolInvocations.filter(
        (invocation) => invocation.execution_id === hit.executionId,
      );
      const recoveredTargetResults = recovered.toolResults.filter((result) =>
        JSON.stringify(result).includes(hit.callRef ?? ""),
      );
      const recoveredTargetArtifacts = recovered.artifacts.filter((artifact) =>
        killedTargetInvocationIds.has(artifact.invocation_id),
      );
      expect(recoveredTargetActions).toEqual(killedTargetActions);
      expect(recoveredTargetInvocations).toEqual(killedTargetInvocations);
      expect(recoveredTargetResults).toEqual(killedTargetResults);
      expect(recoveredTargetArtifacts).toEqual(killedTargetArtifacts);
      expect(targetProviderCalls).toBe(1);
      expect(fixture.daemonErrors).toEqual([]);
      activePhase = "final-assertions-passed";
    },
    120_000,
  );
});
