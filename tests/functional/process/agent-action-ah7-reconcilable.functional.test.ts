import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const readExecutionProviderTurns = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const execution = db
      .prepare(
        "SELECT execution_id, episode_kind, episode_ref FROM executions WHERE execution_id = ?",
      )
      .get(executionId) as
      | {
          execution_id: string;
          episode_kind: string;
          episode_ref: string;
        }
      | undefined;
    const providerTurns = db
      .prepare(
        "SELECT provider_turn_id, execution_id, settled_at, finish_reason FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
      )
      .all(executionId) as Array<{
      provider_turn_id: string;
      execution_id: string;
      settled_at: string | null;
      finish_reason: string | null;
    }>;
    return { execution, providerTurns };
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 Reconcilable tool intent after process crash", () => {
  for (const scenario of [
    {
      boundary: "AH7AfterToolIntentCommit",
      semantics: "Reconcilable",
    },
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "Reconcilable",
    },
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "NonIdempotent",
    },
  ] as const) {
    const { boundary, semantics } = scenario;
    it(`does not replay an ambiguous ${semantics} shell effect after ${boundary}`, async () => {
      const marker = `AH7-SHELL-${crypto.randomUUID().slice(0, 8)}`;
      const steerMarker = `AH7-SHELL-STEER-${crypto.randomUUID().slice(0, 8)}`;
      const effectFile = `ah7-effect-${marker}.txt`;
      const command =
        process.platform === "win32"
          ? `Add-Content -LiteralPath '${effectFile}' -Value '${marker}'`
          : `printf '%s\\n' '${marker}' >> '${effectFile}'`;
      const hits: AhProbeHit[] = [];
      let targetProviderCalls = 0;
      let workProviderCalls = 0;
      let manualWaitCalls = 0;
      let probeArmed = false;
      let latestToolResult = "<none>";
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const names = new Set(call.tools.map((tool) => tool.function?.name));
          const context = JSON.stringify(call.messages);
          if (
            names.has("assign_work") &&
            !names.has("claim_completion") &&
            context.includes(marker)
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Work admitted for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Wait for a human steer, then inspect the workspace with shell for ${marker}.`,
                    why: "qualify Reconcilable shell intent crash",
                    constraints: [],
                    completionExpectation:
                      "shell effect is not blindly replayed",
                    verificationMission: {
                      goal: `Verify safe shell recovery for ${marker}`,
                      criteria: [
                        {
                          criterionId: "shell-safe",
                          requirement: "no ambiguous shell effect is replayed",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH7 Reconcilable functional test",
                  },
                };
          }
          if (
            names.has("claim_completion") &&
            names.has("shell") &&
            context.includes(marker)
          ) {
            workProviderCalls += 1;
            if (!context.includes(steerMarker)) {
              manualWaitCalls += 1;
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `waiting for ${steerMarker}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
            if (!probeArmed) {
              return {
                _tag: "Text",
                text: `Steer reached before the AH7 probe was armed: ${steerMarker}`,
              };
            }
            targetProviderCalls += 1;
            latestToolResult =
              [...call.messages]
                .reverse()
                .find((message) => message.role === "tool")?.content ??
              "<no tool result>";
            if (targetProviderCalls > 5) {
              return { _tag: "HttpError", status: 429 };
            }
            return {
              _tag: "ToolCall",
              name: "shell",
              arguments: {
                command,
                cwd: { mount: "workspace", path: "." },
                timeoutMs: 5_000,
              },
            };
          }
          return { _tag: "Text", text: `Waiting ${marker}` };
        },
        firstDaemonEntry: crashChild,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: boundary,
          ...(semantics === "NonIdempotent"
            ? { ARBOR_AH_NON_IDEMPOTENT: "1" }
            : {}),
        },
        onDaemonStdout: (line) => recordAhProbeLine(hits, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH7 shell intent ambiguity",
        { resourceSelection: "Profile" },
      );
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: project.rootWorkspaceId,
        },
        capability: "shell:exec",
        target: project.rootWorkspaceId,
        expiresAt: null,
      });
      await submitHumanMessage(
        client,
        project,
        `请创建一个等待人工指示后再用 shell 检查工作区的 Work，目标标记 ${marker}。`,
      );
      const approval = await waitForApproval(client, project, marker);
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
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value?.workId !== undefined &&
          value.objective?.includes(marker) === true,
      );
      if (currentWork?.workId === undefined) {
        throw new Error("AH7 public Reconcilable Work was not admitted");
      }
      const workId = currentWork.workId;
      expect(currentWork).toMatchObject({ revision: 0, status: "Open" });
      await waitForPublic(
        async () => ({ workProviderCalls, manualWaitCalls }),
        (value) => value.workProviderCalls >= 1 && value.manualWaitCalls >= 1,
      );
      const idleWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value?.workId === workId && value.activeExecution === undefined,
      );
      expect(idleWork).toMatchObject({ workId, revision: 0, status: "Open" });
      expect(targetProviderCalls).toBe(0);

      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: { severity: "Normal", guidance: steerMarker },
        provenance: { source: "HumanInput" },
      });
      const steeredWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) => value?.workId === workId && value.revision === 1,
      );
      expect(steeredWork?.status).toBe("Open");

      let hit: AhProbeHit | undefined;
      try {
        const observed = await waitForPublic(
          async () => ({ hits, targetProviderCalls }),
          (value) =>
            value.hits.some((candidate) => candidate.boundary === boundary) ||
            value.targetProviderCalls >= 5,
          15_000,
        );
        hit = observed.hits.find(
          (candidate) => candidate.boundary === boundary,
        );
        if (hit === undefined) {
          throw new Error(
            "provider-call cap reached before shell intent probe",
          );
        }
      } catch (error) {
        throw new Error(
          `AH7 shell intent probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      if (hit?.executionId === undefined || hit.invocationId === undefined) {
        throw new Error("AH7 shell probe lacks exact execution/tool identity");
      }
      const targetExecutionId = hit.executionId;
      const crashedActions = crashed.actions.filter(
        (action) => action.execution_id === targetExecutionId,
      );
      const crashedAction = crashedActions.find(
        (action) => action.call_ref === hit.callRef,
      );
      if (
        crashedAction?.logical_action_id === undefined ||
        crashedAction.call_ref === undefined
      ) {
        throw new Error("AH7 crash snapshot lacks exact action identity");
      }
      expect(crashedActions).toHaveLength(1);
      expect(crashedAction.call_ref).toBe(hit.callRef);
      const crashedTarget = readExecutionProviderTurns(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(crashedTarget.execution).toEqual({
        execution_id: targetExecutionId,
        episode_kind: "WorkEpisode",
        episode_ref: workId,
      });
      expect(
        crashed.toolInvocations.filter(
          (invocation) => invocation.execution_id === targetExecutionId,
        ),
      ).toEqual([
        expect.objectContaining({
          invocation_id: hit.invocationId,
          execution_id: targetExecutionId,
          side_effect_semantics: semantics,
          settled_at: null,
        }),
      ]);
      expect(crashedActions).toEqual([
        expect.objectContaining({
          execution_id: targetExecutionId,
          logical_action_id: crashedAction.logical_action_id,
          call_ref: crashedAction.call_ref,
          state: "Pending",
          action_kind: "shell",
        }),
      ]);
      const effectPath = join(fixture.workspaceDirectory, effectFile);
      expect(existsSync(effectPath)).toBe(
        boundary === "AH7AfterToolEffectBeforeSettlement",
      );
      const contentBefore = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      if (contentBefore !== null) {
        expect(contentBefore.trim()).toBe(marker);
      }

      if (semantics === "NonIdempotent") {
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_AH_NON_IDEMPOTENT: "1",
          },
        });
      } else {
        await fixture.restart();
      }
      const recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.actions.some(
            (action) => action.state === "ReconciliationPending",
          ) &&
          value.executions.some(
            (execution) => execution.settlement_kind === "OutcomeUnknown",
          ),
        45_000,
      );
      const recoveredTarget = readExecutionProviderTurns(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(recoveredTarget.execution).toEqual(crashedTarget.execution);
      const recoveredTargetInvocations = recovered.toolInvocations.filter(
        (invocation) => invocation.execution_id === targetExecutionId,
      );
      expect(recoveredTargetInvocations).toHaveLength(1);
      const settledInvocation = recoveredTargetInvocations[0];
      expect(settledInvocation).toMatchObject({
        invocation_id: hit.invocationId,
        execution_id: targetExecutionId,
        side_effect_semantics: semantics,
      });
      if (semantics === "NonIdempotent") {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("OutcomeUnknown");
        expect(JSON.parse(String(settledInvocation?.settlement_json))).toEqual({
          _tag: "OutcomeUnknown",
          reconciliationRefs: [hit?.invocationId],
        });
      } else {
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
        expect(settledInvocation?.settlement_json).toBeNull();
      }
      const recoveredTargetActions = recovered.actions.filter(
        (action) => action.execution_id === targetExecutionId,
      );
      expect(recoveredTargetActions).toEqual([
        expect.objectContaining({
          execution_id: targetExecutionId,
          logical_action_id: crashedAction.logical_action_id,
          call_ref: crashedAction.call_ref,
          state: "ReconciliationPending",
        }),
      ]);
      const recoveredExecution = recovered.executions.find(
        (execution) => execution.execution_id === targetExecutionId,
      );
      const contentAfter = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      expect(recoveredExecution).toMatchObject({
        settlement_kind: "OutcomeUnknown",
      });
      expect(JSON.parse(String(recoveredExecution?.settlement_json))).toEqual({
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: [hit?.invocationId],
        },
      });
      expect(recoveredTarget.providerTurns).toEqual(
        crashedTarget.providerTurns,
      );
      expect(targetProviderCalls).toBe(1);
      expect(contentAfter).toBe(contentBefore);
      expect(fixture.daemonErrors).toEqual([]);
    }, 90_000);
  }
});
