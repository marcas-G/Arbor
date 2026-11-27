import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../../../adapters/persistence-sqlite/src/index.js";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
import { startProductionFixture } from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";
import {
  type Ah7CrashSnapshotExpectation,
  ah7CrashSnapshotExpectations,
  ah7PendingIntentScenarios,
  armPendingIntentBoundaryDiagnostics,
  crashChild,
  fixturePhases,
  fixtures,
  holdPendingIntentSeedWorkTurn,
  p4ImmutableBinding,
  pendingIntentProbeState,
  pendingIntentRecoveryReached,
  type RawP4InvocationRow,
  readRawP4InvocationRows,
} from "./pending-intent-support.js";

describe("AgentLoop and P4 tool intent process crash", () => {
  for (const scenario of ah7PendingIntentScenarios) {
    const { boundary, expectedSettlement } = scenario;
    const testName =
      expectedSettlement === "ExpectedFailure"
        ? "replays the committed P40 ExpectedFailure observation after process crash"
        : `reuses the same action and tool identity after ${boundary}`;
    const baseCrash = ah7CrashSnapshotExpectations[boundary];
    const expectedCrash: Ah7CrashSnapshotExpectation =
      expectedSettlement === "ExpectedFailure"
        ? { ...baseCrash, p4Intent: "ExpectedFailure", artifactCount: 0 }
        : baseCrash;
    it(
      testName,
      async () => {
        const marker = `AH7-${crypto.randomUUID().slice(0, 8)}`;
        const lateProofPath = `ah7-late-proof-${marker}.txt`;
        const hits: AhProbeHit[] = [];
        const daemonOutput: string[] = [];
        let targetProviderCalls = 0;
        let targetReadToolCalls = 0;
        let probeArmed = false;
        let latestToolResult = "<none>";
        const fixture = await startProductionFixture({
          admitWorkspaceDirectory: true,
          daemonEnvironment: {
            ARBOR_AH19_STARTUP_TRACE: "1",
            // Keep the seed daemon from dispatching the newly approved Work
            // before the test kills it; the restarted daemon still gets a
            // bounded scheduler tick instead of inheriting a live seed lease.
            ARBOR_TICK_INTERVAL_MS: "10000",
          },
          preserveDirectoryOnStop: true,
          // See holdPendingIntentSeedWorkTurn: the pre-probe Work-turn
          // request is held without writing any response bytes.
          beforeResponse: holdPendingIntentSeedWorkTurn(() => probeArmed),
          reply: (call) => {
            const context = JSON.stringify(call.messages);
            const available = new Set(
              call.tools
                .map((tool) => tool.function?.name)
                .filter((name): name is string => name !== undefined),
            );
            const targetWorkTurn = available.has("read");
            // The Work objective is a canonical instruction in the provider
            // request. Identify this synthetic provider turn by its exact
            // executable Work surface rather than requiring the objective to
            // be duplicated in the captured chat-message subset.
            if (targetWorkTurn) {
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
            if (targetWorkTurn) {
              const expectedFailureResult = call.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.content?.includes(
                    "filesystem target could not be resolved or accessed inside the sandbox",
                  ) === true,
              );
              if (
                expectedSettlement === "ExpectedFailure" &&
                expectedFailureResult
              ) {
                return {
                  _tag: "Text",
                  text: `Recovered original ExpectedFailure for ${marker}`,
                };
              }
              const readResult = call.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.content?.includes("FUNCTIONAL_VERIFIED") === true,
              );
              if (!readResult) targetReadToolCalls += 1;
              return readResult
                ? { _tag: "Text", text: `Read evidence for ${marker}` }
                : {
                    _tag: "ToolCall",
                    name: "read",
                    arguments: {
                      target: {
                        mount: "workspace",
                        path:
                          expectedSettlement === "ExpectedFailure"
                            ? lateProofPath
                            : "proof.txt",
                      },
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
        fixturePhases.set(fixture, {
          boundary,
          phase: "fixture-ready",
          diagnosticState: () => ({
            marker,
            targetProviderCalls,
            targetReadToolCalls,
            latestToolResult,
            probeTail: hits.slice(-40),
            providerCallCount: fixture.providerCalls.length,
            providerCallTail: fixture.providerCalls.slice(-12).map((call) => ({
              tools: call.tools
                .map((tool) => tool.function?.name)
                .filter((name): name is string => name !== undefined)
                .sort(),
              candidateIds: [
                ...JSON.stringify(call.messages).matchAll(
                  /wrk_[0-9a-f-]{36}/gu,
                ),
              ].map((match) => match[0]),
            })),
          }),
        });
        pendingIntentProbeState.activePhase = "fixture-ready";
        if (boundary === "AH7BeforeToolSettlementCommit") {
          armPendingIntentBoundaryDiagnostics({
            boundary,
            fixture,
            probeState: pendingIntentProbeState,
            readTargetProviderCalls: () => targetProviderCalls,
          });
        }
        const client = makePublicClient(fixture.baseUrl);
        const project = await createFunctionalProject(
          client,
          fixture.workspaceDirectory,
          "AH7 Pending action intent",
          { resourceSelection: "Profile" },
        );
        {
          const phase = fixturePhases.get(fixture);
          if (phase !== undefined) {
            phase.projectId = project.projectId;
            phase.workspaceId = project.rootWorkspaceId;
          }
        }
        await submitHumanMessage(
          client,
          project,
          `请创建并执行一个读取 proof.txt 的目标 ${marker}`,
        );
        pendingIntentProbeState.activePhase = "root-submitted";
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
        pendingIntentProbeState.activePhase = "work-approved";
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
        // A Work execution may have acquired its normal 30-second lease just
        // before the seed daemon stopped. Recovery is intentionally fenced
        // until that lease expires; wait for the durable takeover window
        // instead of treating the live old-generation lease as a test failure.
        await new Promise((resolveWait) => setTimeout(resolveWait, 31_000));
        pendingIntentProbeState.activePhase = "seed-daemon-exited";
        const fixturePhase = fixturePhases.get(fixture);
        if (fixturePhase !== undefined)
          fixturePhase.phase = "probe-daemon-start";
        probeArmed = true;
        const targetProviderCallStart = fixture.providerCalls.length;
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: boundary,
            ARBOR_TICK_INTERVAL_MS: "1000",
          },
        });
        pendingIntentProbeState.activePhase = "probe-daemon-ready";
        if (fixturePhase !== undefined)
          fixturePhase.phase = "probe-daemon-ready";

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
        if (
          !observed.hits.some((candidate) => candidate.boundary === boundary)
        ) {
          await fixture.crash();
          throw new Error(
            `AH7 provider-call cap reached before action-intent probe; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; calls=${JSON.stringify(fixture.providerCalls.slice(-2))}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        }
        const hit = observed.hits.find(
          (candidate) => candidate.boundary === boundary,
        );
        pendingIntentProbeState.activeExecutionId = hit?.executionId;
        pendingIntentProbeState.activePhase = "boundary-reached";
        {
          const phase = fixturePhases.get(fixture);
          if (phase !== undefined) {
            phase.phase = "boundary-reached";
            if (hit?.executionId !== undefined)
              phase.executionId = hit.executionId;
            if (hit?.callRef !== undefined) phase.callRef = hit.callRef;
            if (hit?.providerTurnId !== undefined)
              phase.providerTurnId = hit.providerTurnId;
            if (hit?.logicalActionId !== undefined)
              phase.logicalActionId = hit.logicalActionId;
          }
        }
        expect(hit).toMatchObject({
          executionId: expect.stringMatching(/^exe_/u),
          callRef: expect.any(String),
          ...(expectedCrash.probeIdentity === "Action"
            ? {
                providerTurnId: expect.stringMatching(/^ptn_/u),
                logicalActionId: expect.stringMatching(/^lac_/u),
                actionIndex: 0,
              }
            : { invocationId: expect.stringMatching(/^tin_/u) }),
        });

        await fixture.crash();
        pendingIntentProbeState.activePhase = "probe-daemon-exited";
        const crashed = durableSnapshot(fixture.databaseFile);
        pendingIntentProbeState.activePhase = "kill-snapshot-read";
        const rawTargetInvocations = readRawP4InvocationRows(
          fixture.databaseFile,
          hit?.executionId ?? "",
        );
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
        let committedObservationBytes: Uint8Array | undefined;
        let committedObservationVersion: string | null | undefined;
        let committedObservationHash: string | null | undefined;
        expect(rawTargetInvocations).toHaveLength(
          expectedCrash.p4Intent === "Absent" ? 0 : 1,
        );
        expect(targetSteps).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            provider_turn_id:
              hit?.providerTurnId ?? expect.stringMatching(/^ptn_/u),
            state: "ActionsInProgress",
            next_action_index: expectedCrash.actionCursor,
          }),
        ]);
        expect(targetActions).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            action_index: 0,
            logical_action_id: expect.stringMatching(/^lac_/u),
            call_ref: hit?.callRef,
            action_kind: "read",
            state: expectedCrash.actionState,
          }),
        ]);
        expect(targetInvocations).toHaveLength(
          expectedCrash.p4Intent === "Absent" ? 0 : 1,
        );
        if (expectedCrash.p4Intent === "Pending") {
          expect(targetInvocations).toEqual([
            expect.objectContaining({
              execution_id: hit?.executionId,
              tool_name: "read",
              side_effect_semantics: "ReadOnly",
              settled_at: null,
              settlement_kind: null,
              result_ref: null,
            }),
          ]);
        } else if (
          expectedCrash.p4Intent === "Success" ||
          expectedCrash.p4Intent === "ExpectedFailure"
        ) {
          expect(targetInvocations).toEqual([
            expect.objectContaining({
              execution_id: hit?.executionId,
              tool_name: "read",
              side_effect_semantics: "ReadOnly",
              settled_at: expect.any(String),
              settlement_kind: expectedSettlement,
              result_ref:
                expectedSettlement === "Success" ? expect.any(String) : null,
            }),
          ]);
        }
        expect(targetToolResults).toHaveLength(expectedCrash.toolResultCount);
        expect(targetArtifacts).toHaveLength(expectedCrash.artifactCount);
        if (expectedCrash.p4Intent === "Success") {
          expect(targetInvocations[0]?.result_ref).toBe(
            targetArtifacts[0]?.artifact_id,
          );
        }
        if (expectedSettlement === "ExpectedFailure") {
          const currentSchema = new DatabaseSync(fixture.databaseFile, {
            readOnly: true,
          });
          try {
            const version = currentSchema
              .prepare("PRAGMA user_version")
              .get() as { readonly user_version?: number } | undefined;
            expect(Number(version?.user_version)).toBe(CURRENT_SCHEMA_VERSION);
          } finally {
            currentSchema.close();
          }
          const raw = rawTargetInvocations[0];
          if (raw === undefined || raw.observation_json === null) {
            throw new Error(
              "P40 ExpectedFailure evidence absent at the post-settlement crash boundary",
            );
          }
          committedObservationBytes = Uint8Array.from(raw.observation_json);
          committedObservationVersion = raw.observation_format_version;
          committedObservationHash = raw.observation_sha256;
          if (
            committedObservationVersion === null ||
            committedObservationHash === null
          ) {
            throw new Error("P40 ExpectedFailure version/hash is absent");
          }
          expect(
            JSON.parse(new TextDecoder().decode(raw.observation_json)),
          ).toMatchObject({
            _tag: "ExpectedFailure",
            observation: {
              text: "filesystem target could not be resolved or accessed inside the sandbox",
              truncated: false,
            },
          });
          expect(raw.observation_format_version).toBe(
            "p4-canonical-tool-observation-v1",
          );
          expect(raw.observation_sha256).toMatch(/^[0-9a-f]{64}$/u);
          expect(
            createHash("sha256")
              .update(`${committedObservationVersion}\n`)
              .update(committedObservationBytes)
              .digest("hex"),
          ).toBe(committedObservationHash);
          expect(raw.settlement_json).toBe(
            JSON.stringify({ _tag: "ExpectedFailure" }),
          );
          expect(raw.result_ref).toBeNull();
          expect(targetArtifacts).toHaveLength(0);
        }
        const logicalActionId = (
          targetActions[0] as { logical_action_id?: string } | undefined
        )?.logical_action_id;
        if (logicalActionId === undefined) {
          throw new Error("AH7 committed action identity absent");
        }

        if (expectedSettlement === "ExpectedFailure") {
          // If recovery accidentally re-enters the Read executor, the same
          // request would now succeed. P40 replay must return the exact
          // already-committed ExpectedFailure instead.
          writeFileSync(
            join(fixture.workspaceDirectory, lateProofPath),
            "must not be read by replayed invocation",
          );
        }
        pendingIntentProbeState.activePhase = "recovery-daemon-start";
        if (fixturePhase !== undefined)
          fixturePhase.phase = "recovery-daemon-start";
        await fixture.restart();
        pendingIntentProbeState.activePhase = "recovery-daemon-ready";
        if (fixturePhase !== undefined)
          fixturePhase.phase = "recovery-daemon-ready";
        const recovered = await waitForPublic(
          async () => durableSnapshot(fixture.databaseFile),
          pendingIntentRecoveryReached(
            hit,
            logicalActionId,
            expectedSettlement,
            expectedCrash,
          ),
          45_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH7 restart did not resume the committed Pending action: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
        const recoveredTargetActions = recovered.actions.filter(
          (action) => action.execution_id === hit?.executionId,
        );
        pendingIntentProbeState.activePhase = "recovery-snapshot-ready";
        const recoveredTargetInvocations = recovered.toolInvocations.filter(
          (invocation) => invocation.execution_id === hit?.executionId,
        );
        const recoveredRawInvocations = readRawP4InvocationRows(
          fixture.databaseFile,
          hit?.executionId ?? "",
        );
        const recoveredInvocationId =
          targetInvocationId ?? recoveredTargetInvocations[0]?.invocation_id;
        const recoveredTargetToolResults = recovered.toolResults.filter(
          (result) => JSON.stringify(result).includes(hit?.callRef ?? ""),
        );
        const recoveredTargetArtifacts = recovered.artifacts.filter(
          (artifact) => artifact.invocation_id === recoveredInvocationId,
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
        const recoveredActionRecord = recovered.actions.find(
          (action) => action.logical_action_id === logicalActionId,
        );
        const recoveredActionStep = recovered.steps.find(
          (step) =>
            step.execution_id === hit?.executionId &&
            step.logical_step_no === recoveredActionRecord?.logical_step_no,
        );
        expect(recoveredActionStep?.provider_turn_id).toBe(
          targetSteps[0]?.provider_turn_id,
        );
        if (expectedSettlement === "ExpectedFailure") {
          expect(targetSteps).toHaveLength(1);
          expect(targetSteps[0]).toMatchObject({
            execution_id: hit?.executionId,
            next_action_index: 0,
          });
          const recoveredMatchingSteps = recovered.steps.filter(
            (step) =>
              step.execution_id === hit?.executionId &&
              step.logical_step_no === recoveredActionRecord?.logical_step_no,
          );
          expect(recoveredMatchingSteps).toHaveLength(1);
          expect(recoveredMatchingSteps[0]).toMatchObject({
            execution_id: hit?.executionId,
            provider_turn_id: targetSteps[0]?.provider_turn_id,
            next_action_index: 1,
          });
          const recoveredMatchingActions = recovered.actions.filter(
            (action) =>
              action.execution_id === hit?.executionId &&
              action.logical_step_no === recoveredActionRecord?.logical_step_no,
          );
          expect(recoveredMatchingActions).toHaveLength(1);
          expect(recoveredMatchingActions[0]).toMatchObject({
            logical_action_id: logicalActionId,
            call_ref: hit?.callRef,
          });
          expect(recoveredTargetToolResults).toHaveLength(1);
          expect(recoveredTargetToolResults[0]?.source_ref).toBe(
            recoveredMatchingActions[0]?.observation_source_ref,
          );
        }
        expect(recoveredTargetInvocations).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            tool_name: "read",
            side_effect_semantics: "ReadOnly",
            settlement_kind: expectedSettlement,
            result_ref:
              expectedSettlement === "Success" ? expect.any(String) : null,
          }),
        ]);
        expect(recoveredRawInvocations).toHaveLength(1);
        const recoveredRawInvocation = recoveredRawInvocations[0];
        if (recoveredRawInvocation === undefined) {
          throw new Error("AH7 recovered P4 raw invocation row absent");
        }
        expect(recoveredRawInvocation).toMatchObject({
          invocation_id: recoveredTargetInvocations[0]?.invocation_id,
          execution_id: hit?.executionId,
          workspace_id: project.rootWorkspaceId,
          tool_name: "read",
          side_effect_semantics: "ReadOnly",
          approval_id: null,
          settlement_kind: expectedSettlement,
          result_ref:
            expectedSettlement === "Success"
              ? recoveredTargetArtifacts[0]?.artifact_id
              : null,
        });
        expect(
          recoveredRawInvocation.tool_version.trim().length,
        ).toBeGreaterThan(0);
        expect(recoveredRawInvocation.intent_at.length).toBeGreaterThan(0);
        expect(
          Array.isArray(
            JSON.parse(recoveredRawInvocation.resolved_regions_json),
          ),
        ).toBe(true);
        expect(
          createHash("sha256")
            .update(recoveredRawInvocation.arguments_json)
            .digest("hex"),
        ).toBe(recoveredTargetActions[0]?.input_hash);
        if (targetInvocationId !== undefined) {
          expect(recoveredTargetInvocations[0]?.invocation_id).toBe(
            targetInvocationId,
          );
        }
        expect(recoveredTargetToolResults).toHaveLength(1);
        expect(recoveredTargetArtifacts).toHaveLength(
          expectedSettlement === "Success" ? 1 : 0,
        );
        expect(recoveredTargetInvocations[0]?.result_ref).toBe(
          expectedSettlement === "Success"
            ? recoveredTargetArtifacts[0]?.artifact_id
            : null,
        );
        if (expectedCrash.artifactCount === 1) {
          expect(recoveredTargetArtifacts).toEqual(targetArtifacts);
        }
        if (expectedCrash.p4Intent === "Pending") {
          expect(p4ImmutableBinding(recoveredRawInvocation)).toEqual(
            p4ImmutableBinding(rawTargetInvocations[0] as RawP4InvocationRow),
          );
        } else if (
          expectedCrash.p4Intent === "Success" ||
          expectedCrash.p4Intent === "ExpectedFailure"
        ) {
          expect(recoveredRawInvocations).toEqual(rawTargetInvocations);
          expect(recoveredTargetInvocations).toEqual(targetInvocations);
        }
        expect(recoveredTargetToolResults[0]).toMatchObject({
          source_kind: "AgentLoopAction",
        });
        const recoveredToolResult = JSON.parse(
          String(recoveredTargetToolResults[0]?.payload_json),
        ) as {
          callRef?: string;
          observationRef?: string;
          status?: string;
          outputText?: string;
          truncated?: boolean;
          artifactRefs?: ReadonlyArray<string>;
        };
        expect(recoveredToolResult).toMatchObject({
          callRef: hit?.callRef,
          observationRef: recoveredTargetActions[0]?.observation_source_ref,
        });
        expect(recoveredTargetToolResults[0]?.source_ref).toBe(
          recoveredToolResult.observationRef,
        );
        // ProviderCall count includes both the decision that emits a ToolCall
        // and a later turn that consumes its committed ToolResult. P3/P9
        // source identity is one ToolResult per exact ObservationRef, not one
        // ToolResult per Provider call.
        expect(
          recovered.toolResults.filter(
            (result) =>
              result.source_ref === recoveredToolResult.observationRef,
          ),
        ).toHaveLength(1);
        if (expectedSettlement === "ExpectedFailure") {
          expect(recoveredRawInvocation.observation_format_version).toBe(
            committedObservationVersion,
          );
          expect(recoveredRawInvocation.observation_sha256).toBe(
            committedObservationHash,
          );
          expect(recoveredRawInvocation.observation_json).toEqual(
            committedObservationBytes,
          );
          expect(recoveredRawInvocation.settlement_json).toBe(
            JSON.stringify({ _tag: "ExpectedFailure" }),
          );
          expect(recoveredToolResult).toMatchObject({
            status: "Failed",
            outputText:
              "filesystem target could not be resolved or accessed inside the sandbox",
            truncated: false,
            artifactRefs: [],
          });
          expect(targetReadToolCalls).toBe(1);
          // The read executed exactly once, which is the no-duplicate-effect
          // oracle this scenario owns. The Work loop's remaining turns after
          // the committed ExpectedFailure observation are contract-bounded
          // idle chats (MAX_TURNS) that each carry the failure evidence in
          // their request, exactly like the Success variants' post-read
          // turns; a raw armed-turn ceiling races them. Count instead the
          // proposal-shaped Work turns — the ones whose request does not
          // yet carry the committed failure evidence — and require exactly
          // one: the turn that proposed the read.
          const expectedFailureEvidenceInRequest = (message: {
            readonly role?: string;
            readonly content?: string;
          }): boolean =>
            message.role === "tool" &&
            message.content?.includes(
              "filesystem target could not be resolved or accessed inside the sandbox",
            ) === true;
          expect(
            fixture.providerCalls
              .slice(targetProviderCallStart)
              .filter(
                (call) =>
                  call.tools.some((tool) => tool.function?.name === "read") &&
                  !call.messages.some(expectedFailureEvidenceInRequest),
              ),
          ).toHaveLength(1);
          if (targetProviderCalls >= 2) {
            expect(latestToolResult).toContain(
              "filesystem target could not be resolved or accessed inside the sandbox",
            );
          }
        }
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
                    (message.content?.includes("FUNCTIONAL_VERIFIED") ===
                      true ||
                      message.content?.includes(
                        "filesystem target could not be resolved or accessed inside the sandbox",
                      ) === true),
                ),
            ),
        ).toHaveLength(1);
        expect(fixture.daemonErrors).toEqual([]);
        pendingIntentProbeState.activePhase = "final-assertions-passed";
      },
      expectedCrash.timeoutMs,
    );
  }
});
