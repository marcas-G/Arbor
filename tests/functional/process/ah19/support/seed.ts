import { expect } from "vitest";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../../../support/lease-qualification.js";
import type {
  CapturedProviderCall,
  ProductionFixture,
  ProviderResponseGate,
  ScriptedProviderResponse,
} from "../../../support/production-fixture.js";
import {
  type createFunctionalProject,
  type makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../../../support/public-client.js";
import {
  childEntry,
  probes,
  providerRequests,
  recordAh19Phase,
} from "./diagnostics.js";
import {
  readRootSeedDiagnosticSnapshot,
  readSnapshot,
  readWorkExecutionId,
} from "./snapshot.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export interface ApprovedWorkSeed {
  readonly objective: string;
  readonly why: string;
  readonly constraints: ReadonlyArray<string>;
  readonly completionExpectation: string;
  readonly verificationMission: {
    readonly goal: string;
    readonly criteria: ReadonlyArray<{
      readonly criterionId: string;
      readonly requirement: string;
      readonly required: boolean;
    }>;
    readonly riskRequirements: ReadonlyArray<string>;
  };
}

export interface RootSeedProviderDecision {
  readonly index: number;
  readonly request: CapturedProviderCall;
  readonly selector: {
    readonly availableTools: ReadonlyArray<string>;
    readonly hasAssignWork: boolean;
    readonly hasClaimCompletion: boolean;
    readonly hasMarker: boolean;
    readonly hasWorkAssignedToolResult: boolean;
    readonly assignWorkToolCallAlreadySent: boolean;
  };
  readonly response: ScriptedProviderResponse;
}

export type RootSeedProviderMessage =
  CapturedProviderCall["messages"][number] & {
    readonly tool_call_id?: string;
    readonly tool_calls?: ReadonlyArray<{
      readonly id?: string;
      readonly function?: {
        readonly name?: string;
        readonly arguments?: string;
      };
    }>;
  };

export interface RootSeedDiagnostics {
  readonly providerDecisions: ReadonlyArray<RootSeedProviderDecision>;
  readonly responsesSent: ReadonlyArray<{
    readonly index: number;
    readonly request: CapturedProviderCall;
  }>;
  readonly daemonStdout: ReadonlyArray<string>;
}

export const approvedRootWorkReply = (
  marker: string,
  work: ApprovedWorkSeed,
  onDecision?: (decision: RootSeedProviderDecision) => void,
): ((
  call: CapturedProviderCall,
  index: number,
) => ScriptedProviderResponse) => {
  let assignWorkToolCallSent = false;
  return (call, index) => {
    const available = new Set(
      call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined),
    );
    const context = JSON.stringify(call.messages);
    const providerMessages =
      call.messages as ReadonlyArray<RootSeedProviderMessage>;
    const expectedArguments = {
      ...work,
      reason: "AH19 public Work seed under RootConversation",
    };
    const currentAssignWorkCallIds = new Set(
      providerMessages.flatMap((message) =>
        message.role === "assistant"
          ? (message.tool_calls ?? [])
              .filter((toolCall) => {
                if (
                  toolCall.function?.name !== "assign_work" ||
                  typeof toolCall.id !== "string" ||
                  typeof toolCall.function.arguments !== "string"
                ) {
                  return false;
                }
                try {
                  const args = JSON.parse(
                    toolCall.function.arguments,
                  ) as Record<string, unknown>;
                  return (
                    args.objective === expectedArguments.objective &&
                    args.why === expectedArguments.why &&
                    JSON.stringify(args.constraints) ===
                      JSON.stringify(expectedArguments.constraints) &&
                    args.completionExpectation ===
                      expectedArguments.completionExpectation &&
                    JSON.stringify(args.verificationMission) ===
                      JSON.stringify(expectedArguments.verificationMission) &&
                    args.reason === expectedArguments.reason
                  );
                } catch {
                  return false;
                }
              })
              .map((toolCall) => toolCall.id as string)
          : [],
      ),
    );
    const hasWorkAssignedToolResult = providerMessages.some(
      (message) =>
        message.role === "tool" &&
        typeof message.tool_call_id === "string" &&
        currentAssignWorkCallIds.has(message.tool_call_id) &&
        message.content?.includes("WorkAssigned(") === true,
    );
    const selector = {
      availableTools: [...available].sort(),
      hasAssignWork: available.has("assign_work"),
      hasClaimCompletion: available.has("claim_completion"),
      hasMarker: context.includes(marker),
      hasWorkAssignedToolResult,
      assignWorkToolCallAlreadySent: assignWorkToolCallSent,
    };
    const eligibleRootRequest =
      selector.hasAssignWork &&
      !selector.hasClaimCompletion &&
      selector.hasMarker;
    let response: ScriptedProviderResponse;
    if (!eligibleRootRequest) {
      response = { _tag: "HttpError", status: 500 };
    } else if (!assignWorkToolCallSent) {
      // A textual mention, or even a stale tool result, is not proof that
      // this fixture has proposed and committed this request's AssignWork.
      assignWorkToolCallSent = true;
      response = {
        _tag: "ToolCall",
        name: "assign_work",
        arguments: {
          ...work,
          reason: "AH19 public Work seed under RootConversation",
        },
      };
    } else if (hasWorkAssignedToolResult) {
      response = { _tag: "Text", text: `AH19 Work seed approved: ${marker}` };
    } else {
      response = { _tag: "HttpError", status: 500 };
    }
    onDecision?.({ index, request: call, selector, response });
    return response;
  };
};

export const makeRootSeedSelectorCase = () => {
  const marker = "AH19-root-seed-selector-negative";
  const work: ApprovedWorkSeed = {
    objective: marker,
    why: "selector regression fixture",
    constraints: [],
    completionExpectation: "create the requested Work",
    verificationMission: {
      goal: "preserve the provider response selector",
      criteria: [],
      riskRequirements: [],
    },
  };
  return {
    marker,
    work,
    request: {
      messages: [{ role: "user", content: `Please handle ${marker}.` }],
      tools: [{ function: { name: "assign_work" } }],
    } satisfies CapturedProviderCall,
    assignmentToolCall: (callId: string): RootSeedProviderMessage => ({
      role: "assistant",
      tool_calls: [
        {
          id: callId,
          function: {
            name: "assign_work",
            arguments: JSON.stringify({
              ...work,
              reason: "AH19 public Work seed under RootConversation",
            }),
          },
        },
      ],
    }),
    toolResult: (callId: string, content: string): RootSeedProviderMessage => ({
      role: "tool",
      tool_call_id: callId,
      content,
    }),
  };
};

export const seedRootWorkViaPublicApproval = async (
  fixture: ProductionFixture,
  client: ReturnType<typeof makePublicClient>,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
  marker: string,
  work: ApprovedWorkSeed,
  daemonEnvironment: Readonly<Record<string, string>>,
  heldRequest?: HeldProviderRequest,
  diagnostics?: RootSeedDiagnostics,
): Promise<string> => {
  recordAh19Phase("Work seed public submit", { marker });
  await submitHumanMessage(client, project, `请创建并开始目标 ${marker}。`);
  recordAh19Phase("Work seed public message committed", { marker });
  const approval = await waitForApproval(client, project, marker).catch(
    (error: unknown) => {
      let databaseSnapshot: unknown;
      try {
        databaseSnapshot = readRootSeedDiagnosticSnapshot(
          fixture.databaseFile,
          project,
        );
      } catch (snapshotError) {
        databaseSnapshot = {
          snapshotError:
            snapshotError instanceof Error
              ? (snapshotError.stack ?? snapshotError.message)
              : String(snapshotError),
        };
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; marker=${marker}; providerCalls=${JSON.stringify(fixture.providerCalls)}; providerDecisions=${JSON.stringify(diagnostics?.providerDecisions ?? [])}; responsesSent=${JSON.stringify(diagnostics?.responsesSent ?? [])}; dbSnapshot=${JSON.stringify(databaseSnapshot)}; daemonStdout=${JSON.stringify(diagnostics?.daemonStdout ?? [])}; daemonStderr=${JSON.stringify(fixture.daemonErrors)}`,
      );
    },
  );
  const approvalResolution = await client.command(
    project.projectId,
    "ResolveControlApproval",
    {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "AH19 checkpoint Work seed",
    },
  );
  recordAh19Phase("Work seed approval resolved", {
    marker,
    approvalResolution,
  });
  const current = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective: string;
        revision: number;
        status: string;
      } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value?.objective === work.objective && value.workId !== undefined,
  ).catch(async (error: unknown) => {
    const [currentWork, inbox, tree, transcript] = await Promise.all([
      client.view("current-work", { workspaceId: project.rootWorkspaceId }),
      client.view("inbox-view", { workspaceId: project.rootWorkspaceId }),
      client.view("responsibility-tree", { projectId: project.projectId }),
      client.view("transcript", {
        workspaceId: project.rootWorkspaceId,
        conversationOnly: false,
        limit: 30,
      }),
    ]);
    let databaseSnapshot: unknown;
    try {
      databaseSnapshot = readRootSeedDiagnosticSnapshot(
        fixture.databaseFile,
        project,
      );
    } catch (snapshotError) {
      databaseSnapshot = {
        snapshotError:
          snapshotError instanceof Error
            ? (snapshotError.stack ?? snapshotError.message)
            : String(snapshotError),
      };
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; marker=${marker}; approval=${JSON.stringify(approval)}; approvalResolution=${JSON.stringify(approvalResolution)}; providerCalls=${JSON.stringify(fixture.providerCalls)}; providerDecisions=${JSON.stringify(diagnostics?.providerDecisions ?? [])}; responsesSent=${JSON.stringify(diagnostics?.responsesSent ?? [])}; resolved public state=${JSON.stringify({ currentWork, inbox, tree, transcript })}; dbSnapshot=${JSON.stringify(databaseSnapshot)}; daemonStdout=${JSON.stringify(diagnostics?.daemonStdout ?? [])}; daemonStderr=${JSON.stringify(fixture.daemonErrors)}`,
    );
  });
  if (current?.workId === undefined) {
    throw new Error(`AH19 approved Work is not current: ${marker}`);
  }
  const workId = current.workId;
  recordAh19Phase("Work seed public Current Work", { marker, workId });
  expect(current).toMatchObject({ revision: 0, status: "Open" });

  const firstWorkCall =
    heldRequest === undefined
      ? await waitForPublic(
          async () =>
            fixture.providerCalls.find((call) => {
              const tools = new Set(
                call.tools
                  .map((tool) => tool.function?.name)
                  .filter((name): name is string => name !== undefined),
              );
              return (
                tools.has("claim_completion") &&
                JSON.stringify(call.messages).includes(work.objective)
              );
            }),
          (call) => call !== undefined,
        )
      : (await heldRequest.waitUntilEntered()).call;
  if (firstWorkCall === undefined) {
    throw new Error(`AH19 first Work provider attempt missing: ${marker}`);
  }
  const workExecutionId = await waitForPublic(
    async () =>
      readWorkExecutionId(
        fixture.databaseFile,
        project,
        workId,
        heldRequest !== undefined,
      ),
    (executionId) => executionId !== undefined,
  );
  if (workExecutionId === undefined) {
    throw new Error(`AH19 WorkEpisode Execution is not active: ${workId}`);
  }
  recordAh19Phase("Work seed WorkEpisode active", {
    workId,
    executionId: workExecutionId,
  });
  const preNative =
    heldRequest === undefined
      ? await waitForPublic(
          async () =>
            readSnapshot(fixture.databaseFile, {
              sessionId: project.rootSessionId,
              executionId: workExecutionId,
              workId,
            }),
          (snapshot) =>
            snapshot.providerAttempts.some(
              (attempt) => attempt.outcome !== "InProgress",
            ),
        )
      : readSnapshot(fixture.databaseFile, {
          sessionId: project.rootSessionId,
          executionId: workExecutionId,
          workId,
        });
  if (heldRequest !== undefined) {
    expect(preNative.checkpoints).toEqual([]);
    expect(preNative.actions).toEqual([]);
    expect(preNative.providerAttempts.length).toBeGreaterThan(0);
    for (const attempt of preNative.providerAttempts) {
      expect(attempt.outcome).toBe("InProgress");
      expect(attempt.continuation_checkpoint_json).toBeNull();
      expect(
        (
          JSON.parse(attempt.canonical_event_prefix_json) as Array<{
            _tag?: string;
          }>
        ).every((event) => event._tag === "TurnStarted"),
      ).toBe(true);
      expect(
        JSON.parse(attempt.observation_json) as Record<string, unknown>,
      ).toMatchObject({
        responseStarted: false,
        canonicalEventEmitted: false,
        consumerVisibleOutput: false,
        toolCallProposed: false,
        continuationAvailable: false,
        externalEffectPossible: false,
      });
    }
  }
  recordAh19Phase("Work seed initial public provider step observed", {
    workId,
    executionId: workExecutionId,
    providerCalls: fixture.providerCalls.length,
  });
  expect(providerRequests).toEqual([]);
  expect(probes).toEqual([]);

  // For the pre-checkpoint PoC, the provider has received the complete request
  // but has not emitted response headers or bytes. Kill the ordinary daemon,
  // then explicitly abort the held connection before AH19 recovery starts.
  if (heldRequest !== undefined) {
    await fixture.crash();
    await heldRequest.abort();
  }
  await fixture.restart({ entry: childEntry, daemonEnvironment });
  return workId;
};

export interface HeldProviderRequest {
  readonly beforeResponse: ProviderResponseGate;
  readonly waitUntilEntered: () => Promise<{
    call: CapturedProviderCall;
    index: number;
  }>;
  readonly abort: () => Promise<void>;
}

export const holdProviderRequest = (
  predicate: (call: CapturedProviderCall) => boolean,
): HeldProviderRequest => {
  let enteredResolve!: (value: {
    call: CapturedProviderCall;
    index: number;
  }) => void;
  const entered = new Promise<{
    call: CapturedProviderCall;
    index: number;
  }>((resolveEntered) => {
    enteredResolve = resolveEntered;
  });
  let releaseResolve!: (value: "abort") => void;
  const release = new Promise<"abort">((resolveRelease) => {
    releaseResolve = resolveRelease;
  });
  let completedResolve!: () => void;
  const completed = new Promise<void>((resolveCompleted) => {
    completedResolve = resolveCompleted;
  });
  let enteredOnce = false;
  return {
    beforeResponse: async (call, index) => {
      if (!enteredOnce && predicate(call)) {
        enteredOnce = true;
        enteredResolve({ call, index });
        try {
          return await release;
        } finally {
          completedResolve();
        }
      }
      return "respond";
    },
    waitUntilEntered: () => entered,
    abort: async () => {
      releaseResolve("abort");
      await completed;
    },
  };
};

export const holdFirstWorkProviderRequest = (work: ApprovedWorkSeed) =>
  holdProviderRequest((call) => {
    const tools = new Set(
      call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined),
    );
    return (
      tools.has("claim_completion") &&
      JSON.stringify(call.messages).includes(work.objective)
    );
  });

export const ah19WorkSeed = (
  objective: string,
  marker: string,
  why: string,
  constraints: ReadonlyArray<string> = [],
): ApprovedWorkSeed => ({
  objective: `${objective} ${marker}`,
  why,
  constraints,
  completionExpectation: "continue the same logical step after compaction",
  verificationMission: {
    goal: `Verify one ProviderNative binding checkpoint ${marker}`,
    criteria: [
      {
        criterionId: "ah19-native-binding",
        requirement: "checkpoint continuation is deployment-bound",
        required: true,
      },
    ],
    riskRequirements: [],
  },
});

export const expireLeaseAfterOldDaemonExit = (
  fixture: ProductionFixture,
  sessionId: string,
  executionId: string,
  workId: string,
) => {
  const lease = readSnapshot(fixture.databaseFile, {
    sessionId,
    executionId,
    workId,
  }).leases.find((candidate) => candidate.execution_id === executionId);
  if (lease === undefined)
    throw new Error(`AH19 lease ${executionId} is absent after daemon exit`);
  return expireExecutionLeaseAfterOwnerExitForQualification({
    databaseFile: fixture.databaseFile,
    executionId,
    expected: {
      generation: Number(lease.generation),
      expiresAt: lease.expires_at,
    },
    daemon: {
      crash: fixture.crash,
      snapshot: fixture.daemonProcessSnapshot,
    },
  });
};
