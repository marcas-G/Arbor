import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ProviderResponseGate,
  type ScriptedProviderResponse,
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

interface Ah19Probe {
  readonly tag: "AH19_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
}

interface Ah19ProviderRequest {
  readonly event: "AH19_PROVIDER_REQUEST";
  readonly operationKind: string;
  readonly providerTurnId: string;
  readonly bindingVariant: string;
  readonly hasPublicWorkInput?: boolean;
  readonly workActionHistoryCount?: number;
  readonly items: ReadonlyArray<{
    readonly _tag: string;
    readonly implementation?: string;
    readonly bindingFingerprint?: string;
    readonly opaqueItemRef?: string;
  }>;
}

interface Ah19Snapshot {
  readonly session: { session_id: string; context_epoch: number } | undefined;
  readonly checkpoints: Array<{
    sequence: number;
    item_type: string;
    source_ref: string | null;
    payload_json: string;
    content_hash: string;
  }>;
  readonly providerTurns: Array<{
    provider_turn_id: string;
    execution_id: string;
    session_id: string;
    context_epoch: number;
    manifest_id: string;
    output_contract_ref: string;
    settled_at: string | null;
    finish_reason: string | null;
    manifest_json: string | null;
    portable_request_json: string | null;
  }>;
  readonly providerAttempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    provider_error_kind: string | null;
    settled_at: string | null;
    observation_json: string;
    canonical_event_prefix_json: string;
    delivered_position: number | null;
    continuation_checkpoint_json: string | null;
  }>;
  readonly steps: Array<{
    logical_step_no: number;
    repair_attempt: number;
    provider_turn_id: string;
    state: string;
    next_action_index: number;
    predecessor_logical_step_no: number | null;
    predecessor_repair_attempt: number | null;
    successor_json: string | null;
    decoded_output_hash: string | null;
    model_output_session_sequence: number | null;
  }>;
  readonly actions: Array<{
    logical_step_no: number;
    repair_attempt: number;
    action_index: number;
    logical_action_id: string;
    call_ref: string;
    action_kind: string;
    state: string;
    revision: number;
    observation_source_ref: string | null;
  }>;
  readonly providerLinks: Array<{
    logical_step_no: number;
    repair_attempt: number;
    overflow_ordinal: number;
    role: string;
    provider_turn_id: string;
    predecessor_provider_turn_id: string | null;
    context_epoch: number;
    state: string;
  }>;
  readonly sessionEntries: Array<{
    sequence: number;
    entry_kind: string;
    item_type: string | null;
    source_ref: string | null;
    payload_json: string;
  }>;
  readonly execution:
    | {
        execution_id: string;
        settled_at: string | null;
        settlement_kind: string | null;
      }
    | undefined;
  readonly leases: Array<{
    execution_id: string;
    generation: number;
    expires_at: string;
  }>;
  readonly workWait: { work_id: string } | undefined;
  readonly responseJobs: Array<{
    message_id: string;
    state: string;
    response_body: string | null;
    response_execution_id: string | null;
  }>;
}

const childEntry = resolve(
  "tests/functional/support/ah19-native-daemon-child.mjs",
);
const fixtures: ProductionFixture[] = [];
const reportServers: Server[] = [];
const probes: Ah19Probe[] = [];
const providerRequests: Ah19ProviderRequest[] = [];

const startReportServer = async () => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        providerRequests.push(
          JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as Ah19ProviderRequest,
        );
        response.writeHead(204);
        response.end();
      } catch (error) {
        response.writeHead(400);
        response.end(String(error));
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AH19 report server has no TCP address");
  }
  reportServers.push(server);
  return `http://127.0.0.1:${address.port}/requests`;
};

interface ApprovedWorkSeed {
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

interface RootSeedProviderDecision {
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

type RootSeedProviderMessage = CapturedProviderCall["messages"][number] & {
  readonly tool_call_id?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly id?: string;
    readonly function?: {
      readonly name?: string;
      readonly arguments?: string;
    };
  }>;
};

interface RootSeedDiagnostics {
  readonly providerDecisions: ReadonlyArray<RootSeedProviderDecision>;
  readonly responsesSent: ReadonlyArray<{
    readonly index: number;
    readonly request: CapturedProviderCall;
  }>;
  readonly daemonStdout: ReadonlyArray<string>;
}

const approvedRootWorkReply = (
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

const makeRootSeedSelectorCase = () => {
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

it("AH19 Root Work fake ignores a non-tool WorkAssigned text mention", () => {
  const { marker, work, request } = makeRootSeedSelectorCase();
  const reply = approvedRootWorkReply(marker, work);
  const response = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: "A prior note mentioned WorkAssigned(wrk_example).",
        },
      ],
    },
    0,
  );
  expect(response).toMatchObject({ _tag: "ToolCall", name: "assign_work" });
});

it("AH19 Root Work fake fails closed instead of repeating AssignWork without a ToolResult", () => {
  const { marker, work, request, assignmentToolCall } =
    makeRootSeedSelectorCase();
  const reply = approvedRootWorkReply(marker, work);
  const first = reply(request, 0);
  const second = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        assignmentToolCall("ah19-assign-current"),
      ],
    },
    1,
  );
  expect(first).toMatchObject({ _tag: "ToolCall", name: "assign_work" });
  expect(second).toEqual({ _tag: "HttpError", status: 500 });
  expect(
    [first, second].filter(
      (response) =>
        typeof response !== "string" && response._tag === "ToolCall",
    ),
  ).toHaveLength(1);
});

it("AH19 Root Work fake matches WorkAssigned ToolResult by the emitted call id", () => {
  const { marker, work, request, assignmentToolCall, toolResult } =
    makeRootSeedSelectorCase();
  const reply = approvedRootWorkReply(marker, work);
  const first = reply(request, 0);
  const priorCall = assignmentToolCall("ah19-assign-current");
  const withStaleResult = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        priorCall,
        toolResult("old-unrelated-call", "WorkAssigned(wrk_stale)"),
      ],
    },
    1,
  );
  const withMatchingResult = reply(
    {
      ...request,
      messages: [
        ...request.messages,
        priorCall,
        toolResult("ah19-assign-current", "WorkAssigned(wrk_current)"),
      ],
    },
    2,
  );
  expect(first).toMatchObject({ _tag: "ToolCall", name: "assign_work" });
  expect(withStaleResult).toEqual({ _tag: "HttpError", status: 500 });
  expect(withMatchingResult).toEqual({
    _tag: "Text",
    text: `AH19 Work seed approved: ${marker}`,
  });
});

const seedRootWorkViaPublicApproval = async (
  fixture: ProductionFixture,
  client: ReturnType<typeof makePublicClient>,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
  marker: string,
  work: ApprovedWorkSeed,
  daemonEnvironment: Readonly<Record<string, string>>,
  heldRequest?: HeldProviderRequest,
  diagnostics?: RootSeedDiagnostics,
): Promise<string> => {
  await submitHumanMessage(client, project, `请创建并开始目标 ${marker}。`);
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
    async () => readWorkExecutionId(fixture.databaseFile, project, workId),
    (executionId) => executionId !== undefined,
  );
  if (workExecutionId === undefined) {
    throw new Error(`AH19 WorkEpisode Execution is not active: ${workId}`);
  }
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
              (attempt) => attempt.outcome === "RetryableFailure",
            ),
        )
      : readSnapshot(fixture.databaseFile, {
          sessionId: project.rootSessionId,
          executionId: workExecutionId,
          workId,
        });
  expect(preNative.checkpoints).toEqual([]);
  expect(preNative.actions).toEqual([]);
  if (heldRequest !== undefined) {
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

interface HeldProviderRequest {
  readonly beforeResponse: ProviderResponseGate;
  readonly waitUntilEntered: () => Promise<{
    call: CapturedProviderCall;
    index: number;
  }>;
  readonly abort: () => Promise<void>;
}

const holdProviderRequest = (
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

const holdFirstWorkProviderRequest = (work: ApprovedWorkSeed) =>
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

const ah19WorkSeed = (
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

const readSnapshot = (
  databaseFile: string,
  input: { sessionId: string; executionId: string; workId: string },
): Ah19Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    return {
      session: db
        .prepare(
          "SELECT session_id, context_epoch FROM sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as Ah19Snapshot["session"],
      checkpoints: db
        .prepare(
          `SELECT sequence, item_type, source_ref, payload_json, content_hash
             FROM session_entries WHERE session_id = ?
              AND item_type = 'CompactionCheckpoint' ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah19Snapshot["checkpoints"],
      providerTurns: db
        .prepare(
          `SELECT pt.provider_turn_id, pt.execution_id, pt.session_id,
                  pt.context_epoch, pt.manifest_id, pt.output_contract_ref,
                  pt.settled_at,
                  pt.finish_reason, m.manifest_json, m.portable_request_json
             FROM provider_turns pt
             LEFT JOIN model_context_manifests m
               ON m.provider_turn_id = pt.provider_turn_id
              AND m.manifest_id = pt.manifest_id
            WHERE pt.execution_id = ? ORDER BY pt.provider_turn_id`,
        )
        .all(input.executionId) as Ah19Snapshot["providerTurns"],
      providerAttempts: db
        .prepare(
          `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome,
                  pa.provider_error_kind, pa.settled_at, pa.observation_json,
                  pa.canonical_event_prefix_json, pa.delivered_position,
                  pa.continuation_checkpoint_json
             FROM provider_attempts pa JOIN provider_turns pt
               ON pt.provider_turn_id = pa.provider_turn_id
            WHERE pt.execution_id = ?
            ORDER BY pa.provider_turn_id, pa.attempt_no`,
        )
        .all(input.executionId) as Ah19Snapshot["providerAttempts"],
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  next_action_index,
                  predecessor_logical_step_no, predecessor_repair_attempt,
                  successor_json, decoded_output_hash,
                  model_output_session_sequence
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(input.executionId) as Ah19Snapshot["steps"],
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, action_kind, state, revision,
                  observation_source_ref
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(input.executionId) as Ah19Snapshot["actions"],
      providerLinks: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, overflow_ordinal, role,
                  provider_turn_id, predecessor_provider_turn_id,
                  context_epoch, state
             FROM agent_loop_step_provider_turns WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, overflow_ordinal, role`,
        )
        .all(input.executionId) as Ah19Snapshot["providerLinks"],
      sessionEntries: db
        .prepare(
          `SELECT sequence, entry_kind, item_type, source_ref, payload_json
             FROM session_entries WHERE session_id = ? ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah19Snapshot["sessionEntries"],
      execution: db
        .prepare(
          "SELECT execution_id, settled_at, settlement_kind FROM executions WHERE execution_id = ?",
        )
        .get(input.executionId) as Ah19Snapshot["execution"],
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .all(input.executionId) as Ah19Snapshot["leases"],
      workWait: db
        .prepare("SELECT work_id FROM work_waits WHERE work_id = ?")
        .get(input.workId) as Ah19Snapshot["workWait"],
      responseJobs: db
        .prepare(
          `SELECT message_id, state, response_body, response_execution_id
             FROM conversation_response_jobs
            WHERE active_execution_id = ? OR response_execution_id = ?
            ORDER BY message_id`,
        )
        .all(
          input.executionId,
          input.executionId,
        ) as Ah19Snapshot["responseJobs"],
    };
  } finally {
    db.close();
  }
};

/** One coherent, read-only snapshot used only if AH19's public Root Work seed
 * times out. It distinguishes provider/approval admission from later Work,
 * lease, Inbox, and durable workflow-signal progress. */
const readRootSeedDiagnosticSnapshot = (
  databaseFile: string,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const projectId = project.projectId;
    const workspaceId = project.rootWorkspaceId;
    const sessionId = project.rootSessionId;
    return {
      project: db
        .prepare(
          `SELECT project_id, root_workspace_id, lifecycle, revision
             FROM projects WHERE project_id = ?`,
        )
        .get(projectId),
      workspace: db
        .prepare(
          `SELECT workspace_id, parent_workspace_id, current_work_id,
                  primary_session_id, lifecycle, revision
             FROM workspaces WHERE workspace_id = ?`,
        )
        .get(workspaceId),
      works: db
        .prepare(
          `SELECT work_id, workspace_id, objective, lifecycle, revision,
                  created_at, updated_at
             FROM works WHERE project_id = ? ORDER BY created_at, work_id`,
        )
        .all(projectId),
      executions: db
        .prepare(
          `SELECT execution_id, episode_kind, episode_ref, workspace_id,
                  session_id, admitted_at, settled_at, settlement_kind
             FROM executions WHERE project_id = ?
            ORDER BY admitted_at, execution_id`,
        )
        .all(projectId),
      agentExecutionState: db
        .prepare(
          `SELECT state.execution_id, state.episode_json, state.wake_reason,
                  state.current_mode, state.turn_no, state.updated_at
             FROM agent_execution_state AS state
             JOIN executions AS execution
               ON execution.execution_id = state.execution_id
            WHERE execution.project_id = ?
            ORDER BY execution.admitted_at, state.execution_id`,
        )
        .all(projectId),
      leases: db
        .prepare(
          `SELECT lease.execution_id, lease.worker_id,
                  lease.generation, lease.expires_at
             FROM execution_leases AS lease
             JOIN executions AS execution
               ON execution.execution_id = lease.execution_id
            WHERE execution.project_id = ?
            ORDER BY lease.execution_id`,
        )
        .all(projectId),
      workWaits: db
        .prepare(
          `SELECT wait.work_id, wait.wait_mode, wait.conditions_json,
                  wait.registered_at, wait.updated_at
             FROM work_waits AS wait
             JOIN works AS work ON work.work_id = wait.work_id
            WHERE work.project_id = ? ORDER BY wait.registered_at, wait.work_id`,
        )
        .all(projectId),
      schedulerTimers: db
        .prepare(
          `SELECT timer_id, workspace_id, work_id, kind, fire_at, created_at
             FROM scheduler_timers WHERE workspace_id = ?
            ORDER BY fire_at, timer_id`,
        )
        .all(workspaceId),
      approvals: db
        .prepare(
          `SELECT approval_id, route_kind, project_id, workspace_id,
                  execution_id, stable_action_id, state, revision,
                  requested_at, expires_at, decided_at, consumed_at,
                  binding_proven, source_state
             FROM action_approvals WHERE project_id = ?
            ORDER BY requested_at, approval_id`,
        )
        .all(projectId),
      commandReceipts: db
        .prepare(
          `SELECT command_id, resolution, result_json, terminal_error_json,
                  created_at, settled_at
             FROM commands WHERE project_id = ?
            ORDER BY created_at DESC, command_id DESC LIMIT 40`,
        )
        .all(projectId),
      commandAttempts: db
        .prepare(
          `SELECT attempt.command_id, attempt.attempt_no, attempt.outcome,
                  attempt.failure_kind, attempt.started_at,
                  attempt.settled_at
             FROM command_attempts AS attempt
             JOIN commands AS command
               ON command.command_id = attempt.command_id
            WHERE command.project_id = ?
            ORDER BY command.created_at DESC, attempt.attempt_no DESC
            LIMIT 40`,
        )
        .all(projectId),
      inbox: db
        .prepare(
          `SELECT workspace_id, entry_key, kind, summary, correlation_id,
                  admitted_at, consumed_at
             FROM inbox_entries WHERE workspace_id = ?
            ORDER BY admitted_at, entry_key`,
        )
        .all(workspaceId),
      consumerOffsets: db
        .prepare(
          `SELECT consumer_id, project_id, last_sequence, updated_at
             FROM consumer_offsets WHERE project_id = ?
            ORDER BY consumer_id`,
        )
        .all(projectId),
      workflowSignals: {
        consumerOffset: db
          .prepare(
            `SELECT consumer_id, project_id, last_sequence, updated_at
               FROM consumer_offsets
              WHERE consumer_id = 'workflow-signals' AND project_id = ?`,
          )
          .get(projectId),
        events: db
          .prepare(
            `SELECT event_id, sequence, event_type, aggregate_ref,
                    caused_by_command_id, correlation_ref, occurred_at,
                    payload_json
               FROM domain_events
              WHERE project_id = ? AND event_type IN (
                'DependencyDeclared', 'DependencySatisfied',
                'VerificationConcluded', 'MessageSent', 'ExecutionSettled'
              )
              ORDER BY sequence DESC LIMIT 40`,
          )
          .all(projectId),
      },
      latestDomainEvents: db
        .prepare(
          `SELECT event_id, sequence, event_type, aggregate_ref,
                  caused_by_command_id, correlation_ref, occurred_at,
                  payload_json
             FROM domain_events WHERE project_id = ?
            ORDER BY sequence DESC LIMIT 40`,
        )
        .all(projectId),
      eventSequence: db
        .prepare(
          `SELECT project_id, last_sequence FROM project_event_sequences
            WHERE project_id = ?`,
        )
        .get(projectId),
      session: db
        .prepare(
          `SELECT session_id, binding_kind, workspace_id, execution_id,
                  context_epoch, created_at
             FROM sessions WHERE session_id = ?`,
        )
        .get(sessionId),
      sessionEntries: db
        .prepare(
          `SELECT sequence, entry_kind, item_type, source_ref, payload_json
             FROM session_entries WHERE session_id = ?
            ORDER BY sequence DESC LIMIT 40`,
        )
        .all(sessionId),
    };
  } finally {
    db.close();
  }
};

const readWorkExecutionId = (
  databaseFile: string,
  project: Awaited<ReturnType<typeof createFunctionalProject>>,
  workId: string,
): string | undefined => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT execution_id FROM executions WHERE workspace_id = ? AND episode_kind = 'WorkEpisode' AND episode_ref = ? AND settled_at IS NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(project.rootWorkspaceId, workId) as
      | { execution_id: string }
      | undefined;
    return row?.execution_id;
  } finally {
    db.close();
  }
};

const readExecutionIdForProviderTurn = (
  databaseFile: string,
  providerTurnId: string,
): string => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT execution_id FROM provider_turns WHERE provider_turn_id = ?",
      )
      .get(providerTurnId) as { execution_id: string } | undefined;
    if (row === undefined) {
      throw new Error(`AH19 ProviderTurn missing: ${providerTurnId}`);
    }
    return row.execution_id;
  } finally {
    db.close();
  }
};

const corruptNativeManifestLogicalStepNo = (
  databaseFile: string,
  providerTurnId: string,
  logicalStepNo: number,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT m.manifest_id, m.manifest_json
           FROM model_context_manifests m
          WHERE m.provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) throw new Error("AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    manifest.logicalStepNo = logicalStepNo;
    db.prepare(
      "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
    ).run(JSON.stringify(manifest), row.manifest_id);
  } finally {
    db.close();
  }
};

const corruptOrdinaryNativeSourceIdentity = (
  databaseFile: string,
  providerTurnId: string,
  field:
    | "logicalStepNo"
    | "repairAttempt"
    | "providerTurnId"
    | "executionId"
    | "bindingFingerprint",
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined)
      throw new Error("ordinary AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const identity = manifest.sourceAgentLoopStep as Record<string, unknown>;
    if (typeof identity !== "object" || identity === null) {
      throw new Error("ordinary AH19 Native source identity missing");
    }
    if (field === "bindingFingerprint") {
      manifest.resolvedModelBindingFingerprint =
        "p16fp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    } else if (field === "logicalStepNo" || field === "repairAttempt") {
      identity[field] = Number(identity[field]) + 1;
    } else {
      identity[field] = `${String(identity[field])}-wrong`;
    }
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `ordinary AH19 Native identity corruption missed ${field}`,
      );
    }
  } finally {
    db.close();
  }
};

const corruptOrdinaryNativeManifestField = (
  databaseFile: string,
  providerTurnId: string,
  field: "compiledRequestHash" | "contextEpoch",
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json, portable_request_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | {
          manifest_id: string;
          manifest_json: string;
          portable_request_json: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error("ordinary AH19 Native manifest/request missing");
    }
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const originalValue = manifest[field];
    if (field === "compiledRequestHash") {
      const persistedRequestHash = createHash("sha256")
        .update(row.portable_request_json)
        .digest("hex");
      if (originalValue !== persistedRequestHash) {
        throw new Error("ordinary AH19 Native request hash was not canonical");
      }
      manifest.compiledRequestHash = "0".repeat(64);
    } else {
      if (!Number.isSafeInteger(originalValue)) {
        throw new Error("ordinary AH19 Native manifest epoch was not integral");
      }
      manifest.contextEpoch = Number(originalValue) + 1;
    }
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1 || manifest[field] === originalValue) {
      throw new Error(`ordinary AH19 Native corruption missed ${field}`);
    }
    return {
      originalValue,
      corruptedValue: manifest[field],
      portableRequestJson: row.portable_request_json,
    };
  } finally {
    db.close();
  }
};

const appendSecondOrdinaryNativeCandidate = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const turn = db
      .prepare("SELECT * FROM provider_turns WHERE provider_turn_id = ?")
      .get(providerTurnId) as Record<string, SQLInputValue> | undefined;
    const manifest = db
      .prepare(
        "SELECT * FROM model_context_manifests WHERE provider_turn_id = ?",
      )
      .get(providerTurnId) as Record<string, SQLInputValue> | undefined;
    if (turn === undefined || manifest === undefined) {
      throw new Error("AH19 source Native candidate rows missing");
    }
    const secondTurnId = `${providerTurnId}_ambiguous`;
    const secondManifestId = `${String(manifest.manifest_id)}_ambiguous`;
    const secondManifestJson = JSON.parse(
      String(manifest.manifest_json),
    ) as Record<string, unknown>;
    secondManifestJson.providerTurnId = secondTurnId;
    const turnCopy = {
      ...turn,
      provider_turn_id: secondTurnId,
      manifest_id: secondManifestId,
    };
    const manifestCopy = {
      ...manifest,
      manifest_id: secondManifestId,
      provider_turn_id: secondTurnId,
      manifest_json: JSON.stringify(secondManifestJson),
    };
    const insertRow = (table: string, row: Record<string, SQLInputValue>) => {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column] ?? null));
    };
    insertRow("provider_turns", turnCopy);
    insertRow("model_context_manifests", manifestCopy);
    const candidates = db
      .prepare(
        `SELECT m.provider_turn_id, m.session_id, m.context_epoch,
                m.manifest_json, m.portable_request_json,
                t.output_contract_ref
           FROM model_context_manifests m
           JOIN provider_turns t
             ON t.provider_turn_id = m.provider_turn_id
            AND t.manifest_id = m.manifest_id
          WHERE m.session_id = ? AND m.context_epoch = ?
            AND json_extract(m.manifest_json, '$.operationKind') = 'CompactionNative'`,
      )
      .all(
        String(manifest.session_id),
        Number(manifest.context_epoch),
      ) as Array<{
      provider_turn_id: string;
      session_id: string;
      context_epoch: number;
      manifest_json: string;
      portable_request_json: string;
      output_contract_ref: string;
    }>;
    if (
      candidates.length !== 2 ||
      candidates.some(
        (candidate) =>
          candidate.session_id !== manifest.session_id ||
          candidate.context_epoch !== manifest.context_epoch ||
          candidate.output_contract_ref !== "provider-native-compaction-v1" ||
          candidate.portable_request_json !== manifest.portable_request_json ||
          JSON.parse(candidate.manifest_json).operationKind !==
            "CompactionNative",
      )
    ) {
      throw new Error(
        "AH19 second Native candidate was not a valid same-epoch row",
      );
    }
    return { secondTurnId, candidateCount: candidates.length };
  } finally {
    db.close();
  }
};

const corruptNativeManifestFrontierHalfNull = (
  databaseFile: string,
  providerTurnId: string,
  nullSide: "firstSequence" | "lastSequence",
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) throw new Error("AH19 Native manifest missing");
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const frontier = manifest.inputFrontier as
      | Record<string, unknown>
      | undefined;
    if (
      frontier === undefined ||
      typeof frontier.firstSequence !== "number" ||
      typeof frontier.lastSequence !== "number"
    ) {
      throw new Error("AH19 fixture did not form a non-empty Native frontier");
    }
    frontier[nullSide] = null;
    db.prepare(
      "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
    ).run(JSON.stringify(manifest), row.manifest_id);
  } finally {
    db.close();
  }
};

const markStepNextReadyWithoutSuccessor = (
  databaseFile: string,
  executionId: string,
  logicalStepNo: number,
  repairAttempt: number,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare(
        `UPDATE agent_loop_steps
            SET state = 'NextStepReady'
          WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?
            AND successor_json IS NULL`,
      )
      .run(executionId, logicalStepNo, repairAttempt);
    if (Number(result.changes) !== 1) {
      throw new Error("AH19 NextStepReady no-successor mutation missed");
    }
  } finally {
    db.close();
  }
};

const corruptCompiledInferenceRequestHash = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT manifest_id, manifest_json
           FROM model_context_manifests
          WHERE provider_turn_id = ?`,
      )
      .get(providerTurnId) as
      | { manifest_id: string; manifest_json: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`AH19 inference manifest missing: ${providerTurnId}`);
    }
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    const originalHash = manifest.compiledRequestHash;
    if (typeof originalHash !== "string" || originalHash === "00000000") {
      throw new Error(
        `AH19 inference compiled hash invalid: ${providerTurnId}`,
      );
    }
    manifest.compiledRequestHash = "00000000";
    const result = db
      .prepare(
        `UPDATE model_context_manifests
            SET manifest_json = ?
          WHERE manifest_id = ?`,
      )
      .run(JSON.stringify(manifest), row.manifest_id);
    if (Number(result.changes) !== 1) {
      throw new Error(
        `AH19 inference hash corruption missed ${providerTurnId}`,
      );
    }
    return { originalHash, corruptedHash: manifest.compiledRequestHash };
  } finally {
    db.close();
  }
};

const corruptNativeSourceLink = (
  databaseFile: string,
  providerTurnId: string,
  corruption: "repairAttempt" | "role" | "predecessor",
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    if (corruption === "repairAttempt") db.exec("PRAGMA foreign_keys = OFF");
    const statement =
      corruption === "repairAttempt"
        ? "UPDATE agent_loop_step_provider_turns SET repair_attempt = 1 WHERE provider_turn_id = ?"
        : corruption === "role"
          ? "UPDATE agent_loop_step_provider_turns SET role = 'OverflowReplacement' WHERE provider_turn_id = ?"
          : "UPDATE agent_loop_step_provider_turns SET predecessor_provider_turn_id = ? WHERE provider_turn_id = ?";
    const result =
      corruption === "predecessor"
        ? db.prepare(statement).run(`ptn_${executionId}_0`, providerTurnId)
        : db.prepare(statement).run(providerTurnId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 source link corruption missed ${providerTurnId}`);
    }
  } finally {
    db.close();
  }
};

const corruptNativeSuccessPrefix = (
  databaseFile: string,
  providerTurnId: string,
  corruption:
    | "truncated"
    | "duplicate-terminal"
    | "invalid-continuation"
    | "identity-mismatch",
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT canonical_event_prefix_json
           FROM provider_attempts
          WHERE provider_turn_id = ? AND attempt_no = 0`,
      )
      .get(providerTurnId) as
      | { canonical_event_prefix_json: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`AH19 Native Attempt missing: ${providerTurnId}`);
    }
    const events = JSON.parse(row.canonical_event_prefix_json) as Array<
      Record<string, unknown>
    >;
    if (corruption === "truncated") {
      events.pop();
    } else if (corruption === "duplicate-terminal") {
      const terminal = events.at(-1);
      if (terminal === undefined) {
        throw new Error("AH19 Native prefix has no terminal to duplicate");
      }
      events.push({ ...terminal });
    } else if (corruption === "invalid-continuation") {
      const continuation = events.find(
        (event) => event._tag === "ContinuationState",
      );
      if (continuation === undefined) {
        throw new Error("AH19 Native prefix has no continuation state");
      }
      continuation.stateRef = "";
    } else {
      const started = events[0];
      if (started === undefined || started._tag !== "TurnStarted") {
        throw new Error("AH19 Native prefix has no TurnStarted event");
      }
      started.providerTurnId = `ptn_${executionId}_wrong_turn`;
    }
    const result = db
      .prepare(
        `UPDATE provider_attempts
            SET canonical_event_prefix_json = ?
          WHERE provider_turn_id = ? AND attempt_no = 0`,
      )
      .run(JSON.stringify(events), providerTurnId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Native prefix corruption missed ${providerTurnId}`);
    }
  } finally {
    db.close();
  }
};

const corruptStepSuccessorPredecessor = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare(
        `UPDATE agent_loop_steps
            SET predecessor_logical_step_no = 0,
                predecessor_repair_attempt = 0
          WHERE execution_id = ? AND logical_step_no = 2 AND repair_attempt = 0`,
      )
      .run(executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Step 2 successor corruption missed ${executionId}`);
    }
  } finally {
    db.close();
  }
};

const corruptStepSuccessorLogicalStepNo = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const row = db
      .prepare(
        `SELECT successor_json FROM agent_loop_steps
          WHERE execution_id = ? AND logical_step_no = 1 AND repair_attempt = 0`,
      )
      .get(executionId) as { successor_json: string | null } | undefined;
    if (row?.successor_json === null || row?.successor_json === undefined) {
      throw new Error(`AH19 Step 1 successor missing: ${executionId}`);
    }
    const successor = JSON.parse(row.successor_json) as Record<string, unknown>;
    successor.logicalStepNo = 3;
    const result = db
      .prepare(
        `UPDATE agent_loop_steps SET successor_json = ?
          WHERE execution_id = ? AND logical_step_no = 1 AND repair_attempt = 0`,
      )
      .run(JSON.stringify(successor), executionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`AH19 Step 1 successor corruption missed ${executionId}`);
    }
  } finally {
    db.close();
  }
};

const startAtCheckpointBoundary = async (
  boundary:
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit"
    | "AH12BeforeSuccessCommit"
    | "AH11AfterStepEffectsCommit",
  extraDaemonEnvironment: Readonly<Record<string, string>> = {},
  episode: "Work" | "ConversationResponse" = "Work",
) => {
  probes.length = 0;
  providerRequests.length = 0;
  const reportUrl = await startReportServer();
  const workMarker = `AH19-CHECKPOINT-${crypto.randomUUID()}`;
  const workSeed = ah19WorkSeed(
    "Qualify a deployment-bound ProviderNative checkpoint.",
    workMarker,
    "exercise AH19 Native binding qualification",
    ["never reuse opaque continuation across deployments"],
  );
  const heldWorkRequest =
    episode === "Work" ? holdFirstWorkProviderRequest(workSeed) : undefined;
  const childOutput: string[] = [];
  const fixture = await startProductionFixture({
    reply:
      episode === "Work"
        ? approvedRootWorkReply(workMarker, workSeed)
        : () => ({ _tag: "HttpError", status: 500 }),
    ...(heldWorkRequest === undefined
      ? {}
      : { beforeResponse: heldWorkRequest.beforeResponse }),
    daemonEnvironment: { ARBOR_AH19_REPORT_URL: reportUrl },
    onDaemonStdout: (line) => {
      childOutput.push(line);
      try {
        const event = JSON.parse(line) as Ah19Probe;
        if (event.tag === "AH19_PROBE") probes.push(event);
      } catch {
        // Preserve other daemon output in fixture diagnostics.
      }
    },
  }).catch((error: unknown) => {
    throw new Error(
      `AH19 daemon failed startup: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}`,
    );
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH19 ProviderNative binding ${boundary}`,
  );
  const ah19DaemonEnvironment = {
    ARBOR_AH19_BOUNDARY: boundary,
    ARBOR_AH19_BINDING_VARIANT: "A",
    ARBOR_AH19_REPORT_URL: reportUrl,
    ...(episode === "ConversationResponse"
      ? { ARBOR_AH19_TERMINAL_CONVERSATION: "1" }
      : {}),
    ...extraDaemonEnvironment,
  };
  let workId: string;
  if (episode === "Work") {
    workId = await seedRootWorkViaPublicApproval(
      fixture,
      client,
      project,
      workMarker,
      workSeed,
      ah19DaemonEnvironment,
      heldWorkRequest,
    );
  } else {
    workId = functionalId("wrk");
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: ah19DaemonEnvironment,
    });
    await submitHumanMessage(
      client,
      project,
      `AH19 terminal response ${crypto.randomUUID()}`,
    );
  }
  const probe = await waitForPublic(
    async () => {
      if (boundary !== "AH12BeforeSuccessCommit") {
        return probes.find((entry) => entry.boundary === boundary);
      }
      const request = providerRequests.find(
        (event) => event.operationKind === "CompactionNative",
      );
      if (request === undefined) return undefined;
      const executionId = readExecutionIdForProviderTurn(
        fixture.databaseFile,
        request.providerTurnId,
      );
      const snapshot = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      const turn = snapshot.providerTurns.find(
        (row) => row.provider_turn_id === request.providerTurnId,
      );
      const attempts = snapshot.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === request.providerTurnId,
      );
      const attempt = attempts[0];
      let events: Array<Record<string, unknown>> = [];
      let observation: Record<string, unknown> = {};
      try {
        events = JSON.parse(
          attempt?.canonical_event_prefix_json ?? "[]",
        ) as Array<Record<string, unknown>>;
        observation = JSON.parse(attempt?.observation_json ?? "{}") as Record<
          string,
          unknown
        >;
      } catch {
        return undefined;
      }
      const continuationEvents = events.filter(
        (event) => event._tag === "ContinuationState",
      );
      if (
        turn?.settled_at === null &&
        turn.output_contract_ref === "provider-native-compaction-v1" &&
        attempts.length === 1 &&
        attempt?.outcome === "InProgress" &&
        attempt.delivered_position === 0 &&
        attempt.continuation_checkpoint_json === null &&
        events[0]?._tag === "TurnStarted" &&
        events[0].providerTurnId === request.providerTurnId &&
        events[0].attemptNo === 0 &&
        continuationEvents.length === 1 &&
        continuationEvents[0]?.stateRef ===
          `ah19-opaque:${request.providerTurnId}` &&
        events.at(-1)?._tag === "TurnCompleted" &&
        events.at(-1)?.finishReason === "Stop" &&
        observation.responseStarted === true &&
        observation.canonicalEventEmitted === true &&
        observation.consumerVisibleOutput === false &&
        observation.toolCallProposed === false &&
        observation.continuationAvailable === true &&
        observation.externalEffectPossible === false
      ) {
        return {
          tag: "AH19_PROBE" as const,
          boundary,
          providerTurnId: request.providerTurnId,
          executionId,
        };
      }
      return undefined;
    },
    (entry) => entry !== undefined,
    60_000,
  ).catch((error: unknown) => {
    const latestNativeRequest = providerRequests
      .filter((event) => event.operationKind === "CompactionNative")
      .at(-1);
    const boundarySnapshot =
      latestNativeRequest === undefined
        ? undefined
        : readSnapshot(fixture.databaseFile, {
            sessionId: project.rootSessionId,
            executionId: readExecutionIdForProviderTurn(
              fixture.databaseFile,
              latestNativeRequest.providerTurnId,
            ),
            workId,
          });
    const latestNativeRow = boundarySnapshot?.providerTurns.find(
      (row) => row.provider_turn_id === latestNativeRequest?.providerTurnId,
    );
    let latestNativeIdentity: unknown;
    try {
      latestNativeIdentity = (
        JSON.parse(latestNativeRow?.manifest_json ?? "{}") as Record<
          string,
          unknown
        >
      ).sourceAgentLoopStep;
    } catch {
      latestNativeIdentity = "invalid";
    }
    throw new Error(
      `AH19 checkpoint boundary missing ${boundary}: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}; providerRequests=${JSON.stringify(providerRequests)}; nativeSourceIdentity=${JSON.stringify(latestNativeIdentity)}; session=${JSON.stringify(boundarySnapshot?.session)}; checkpoints=${JSON.stringify(boundarySnapshot?.checkpoints)}; steps=${JSON.stringify(boundarySnapshot?.steps)}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  if (probe === undefined) throw new Error("AH19 checkpoint probe missing");
  const executionId =
    probe.executionId ??
    readExecutionIdForProviderTurn(fixture.databaseFile, probe.providerTurnId);
  return {
    fixture,
    project,
    workId,
    probe: { ...probe, executionId },
    reportUrl,
    childOutput,
  };
};

const startOrdinaryNativeAtCheckpointBoundary = async (
  boundary:
    | "AH17BeforeCheckpointEpochCommit"
    | "AH17AfterCheckpointEpochCommit",
) => {
  probes.length = 0;
  providerRequests.length = 0;
  const reportUrl = await startReportServer();
  const workMarker = `AH19-ORDINARY-${crypto.randomUUID()}`;
  const workSeed = ah19WorkSeed(
    "Build public Work history for ordinary Native recovery.",
    workMarker,
    "qualify ordinary Native checkpoint recovery",
  );
  const heldWorkRequest = holdFirstWorkProviderRequest(workSeed);
  const childOutput: string[] = [];
  const providerDecisions: RootSeedProviderDecision[] = [];
  const responsesSent: Array<RootSeedDiagnostics["responsesSent"][number]> = [];
  const fixture = await startProductionFixture({
    reply: approvedRootWorkReply(workMarker, workSeed, (decision) =>
      providerDecisions.push(decision),
    ),
    beforeResponse: heldWorkRequest.beforeResponse,
    onResponseSent: (call, index) =>
      responsesSent.push({ index, request: call }),
    daemonEnvironment: { ARBOR_AH19_REPORT_URL: reportUrl },
    onDaemonStdout: (line) => {
      childOutput.push(line);
      try {
        const event = JSON.parse(line) as Ah19Probe;
        if (event.tag === "AH19_PROBE") probes.push(event);
      } catch {
        // Preserve other daemon output in fixture diagnostics.
      }
    },
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH19 ordinary Native recovery ${boundary}`,
  );
  const workId = await seedRootWorkViaPublicApproval(
    fixture,
    client,
    project,
    workMarker,
    workSeed,
    {
      ARBOR_AH19_BOUNDARY: boundary,
      ARBOR_AH19_BINDING_VARIANT: "A",
      ARBOR_AH19_ORDINARY_WORK: "1",
      ARBOR_AH19_CONTEXT_WINDOW: "16384",
      ARBOR_AH19_REPORT_URL: reportUrl,
    },
    heldWorkRequest,
    {
      providerDecisions,
      responsesSent,
      daemonStdout: childOutput,
    },
  );
  for (let index = 0; index < 10; index += 1) {
    const observed = await waitForPublic(
      async () => ({
        native: providerRequests.find(
          (request) => request.operationKind === "CompactionNative",
        ),
        current: await client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      }),
      (state) => state.native !== undefined || state.current?.status === "Open",
      60_000,
    );
    if (observed.native !== undefined) break;
    if (observed.current?.workId !== workId)
      throw new Error("ordinary Work ceased to be current");
    const beforeSteer = providerRequests.length;
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: observed.current.revision,
      steer: {
        severity: "Normal",
        guidance: `AH19 ordinary recovery history ${index}`,
      },
      provenance: { source: "HumanInput" },
    });
    await waitForPublic(
      async () => ({
        count: providerRequests.length,
        native: providerRequests.find(
          (request) => request.operationKind === "CompactionNative",
        ),
      }),
      (state) => state.count >= beforeSteer + 2 || state.native !== undefined,
      60_000,
    );
  }
  const probe = await waitForPublic(
    async () => probes.find((event) => event.boundary === boundary),
    (event) => event !== undefined,
    60_000,
  );
  if (probe === undefined)
    throw new Error(`ordinary Native boundary missing: ${boundary}`);
  const native = providerRequests.find(
    (request) => request.operationKind === "CompactionNative",
  );
  if (native === undefined) throw new Error("ordinary Native request missing");
  return { fixture, project, workId, probe, native, reportUrl, childOutput };
};

const waitForLeaseExpiry = async (
  fixture: ProductionFixture,
  sessionId: string,
  executionId: string,
  workId: string,
) =>
  waitForPublic(
    async () =>
      readSnapshot(fixture.databaseFile, { sessionId, executionId, workId })
        .leases[0],
    (lease) =>
      lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
    35_000,
  );

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const server of reportServers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
    });
  }
});

describe("AH19 ProviderNative binding recovery", () => {
  it("enters ordinary Native compaction from public Work Session history", async () => {
    probes.length = 0;
    providerRequests.length = 0;
    const reportUrl = await startReportServer();
    const seedMarker = `AH19-WORK-HISTORY-${crypto.randomUUID()}`;
    const workSeed: ApprovedWorkSeed = {
      objective: `Build real Workspace Session history through public Work input. ${seedMarker}`,
      why: "qualify ordinary Native compaction after repeated Work turns",
      constraints: [],
      completionExpectation: "history is projected into the next Agent turn",
      verificationMission: {
        goal: "observe ordinary Work history compaction",
        criteria: [
          {
            criterionId: "history-compaction",
            requirement: "older Session history reaches context planning",
            required: true,
          },
        ],
        riskRequirements: [],
      },
    };
    const heldWorkRequest = holdFirstWorkProviderRequest(workSeed);
    const fixture = await startProductionFixture({
      reply: approvedRootWorkReply(seedMarker, workSeed),
      beforeResponse: heldWorkRequest.beforeResponse,
      daemonEnvironment: { ARBOR_AH19_REPORT_URL: reportUrl },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as Ah19Probe;
          if (event.tag === "AH19_PROBE") probes.push(event);
        } catch {
          // Preserve other daemon output in fixture diagnostics.
        }
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH19 ordinary Work history",
    );
    const workId = await seedRootWorkViaPublicApproval(
      fixture,
      client,
      project,
      seedMarker,
      workSeed,
      {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CONTEXT_WINDOW: "16384",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
      heldWorkRequest,
    );

    await waitForPublic(
      async () => ({
        count: providerRequests.length,
        native: providerRequests.find(
          (request) => request.operationKind === "CompactionNative",
        ),
      }),
      (state) => state.count >= 2 || state.native !== undefined,
      60_000,
    );

    for (let index = 0; index < 10; index += 1) {
      const observed = await waitForPublic(
        async () => ({
          native: providerRequests.find(
            (request) => request.operationKind === "CompactionNative",
          ),
          current: await client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        }),
        (state) =>
          state.native !== undefined ||
          (state.current?.workId === workId && state.current.status === "Open"),
        60_000,
      );
      if (observed.native !== undefined) break;
      if (observed.current?.workId !== workId) {
        throw new Error(
          "public Work stopped being current during history fixture",
        );
      }
      const before = providerRequests.length;
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: observed.current.revision,
        steer: {
          severity: "Normal",
          guidance: `AH19 public Work history turn ${index}`,
        },
        provenance: { source: "HumanInput" },
      });
      await waitForPublic(
        async () => ({
          count: providerRequests.length,
          native: providerRequests.find(
            (request) => request.operationKind === "CompactionNative",
          ),
        }),
        (state) => state.count >= before + 2 || state.native !== undefined,
        60_000,
      );
      if (
        providerRequests.some(
          (request) => request.operationKind === "CompactionNative",
        )
      ) {
        break;
      }
    }

    const ordinaryNative = providerRequests.find(
      (request) => request.operationKind === "CompactionNative",
    );
    expect(
      providerRequests.some((request) => request.operationKind === "Inference"),
    ).toBe(true);
    expect(ordinaryNative).toBeDefined();
    expect(ordinaryNative?.providerTurnId).toMatch(/_native_compact_0$/u);
    expect(ordinaryNative?.providerTurnId).not.toContain("_overflow_");
    expect(ordinaryNative?.hasPublicWorkInput).toBe(true);
    expect(ordinaryNative?.workActionHistoryCount).toBeGreaterThan(0);
    const executionId = readExecutionIdForProviderTurn(
      fixture.databaseFile,
      ordinaryNative?.providerTurnId ?? "",
    );
    const snapshot = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(
      snapshot.sessionEntries.some((entry) =>
        entry.payload_json.includes("AH19 public Work history"),
      ),
    ).toBe(true);
    expect(
      snapshot.providerLinks.some((link) => link.role === "OverflowCompaction"),
    ).toBe(false);
    const nativeTurn = snapshot.providerTurns.find(
      (turn) => turn.provider_turn_id === ordinaryNative?.providerTurnId,
    );
    const nativeManifest = JSON.parse(nativeTurn?.manifest_json ?? "{}") as {
      sourceAgentLoopStep?: {
        executionId?: string;
        logicalStepNo?: number;
        repairAttempt?: number;
        providerTurnId?: string;
      };
    };
    const sourceStep = snapshot.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(nativeManifest.sourceAgentLoopStep).toEqual({
      executionId,
      logicalStepNo: 1,
      repairAttempt: 0,
      providerTurnId: sourceStep?.provider_turn_id,
    });

    const replacementInferenceId = ordinaryNative?.providerTurnId.replace(
      "_native_compact_0",
      "",
    );
    const resumedInference = await waitForPublic(
      async () =>
        providerRequests.find(
          (request) =>
            request.operationKind === "Inference" &&
            request.providerTurnId === replacementInferenceId &&
            request.items.some(
              (item) =>
                item._tag === "CompactionCheckpoint" &&
                item.implementation === "ProviderNative",
            ),
        ),
      (request) => request !== undefined,
      45_000,
    );
    expect(resumedInference?.workActionHistoryCount).toBe(0);
    expect(resumedInference?.items).toContainEqual(
      expect.objectContaining({
        _tag: "CompactionCheckpoint",
        implementation: "ProviderNative",
        opaqueItemRef: `ah19-opaque:${ordinaryNative?.providerTurnId}`,
      }),
    );
    await waitForPublic(
      async () =>
        providerRequests.find(
          (request) =>
            request.operationKind === "Inference" &&
            request.providerTurnId === `ptn_${executionId}_1`,
        ),
      (request) => request !== undefined,
      45_000,
    );
    expect(
      providerRequests.filter(
        (request) => request.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 120_000);

  it.each([
    "AH17BeforeCheckpointEpochCommit",
    "AH17AfterCheckpointEpochCommit",
  ] as const)(
    "persists one real ProviderNative checkpoint at %s",
    async (boundary) => {
      const scenario = await startAtCheckpointBoundary(boundary);
      const { fixture, project, workId, probe } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(probe.providerTurnId).toBe(nativeTurnId);
      expect(beforeKill.session?.context_epoch).toBe(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeKill.checkpoints).toHaveLength(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeKill.providerTurns).toHaveLength(3);
      const nativeTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(nativeTurn).toMatchObject({
        execution_id: executionId,
        session_id: project.rootSessionId,
        context_epoch: 0,
        settled_at: expect.any(String),
        finish_reason: "Stop",
        manifest_json: expect.any(String),
      });
      expect(JSON.parse(nativeTurn?.manifest_json ?? "{}")).toMatchObject({
        operationKind: "CompactionNative",
        resolvedModelBindingFingerprint:
          expect.stringMatching(/^p16fp_[0-9a-f]{64}$/u),
        inputFrontier: {
          firstSequence: expect.any(Number),
          lastSequence: expect.any(Number),
        },
        contextRefs: expect.arrayContaining([expect.any(String)]),
      });
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(providerRequests.map((event) => event.operationKind)).toEqual([
        "Inference",
        "Inference",
        "CompactionNative",
      ]);
      expect(beforeKill.steps).toEqual([
        expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
        expect.objectContaining({ logical_step_no: 1, repair_attempt: 0 }),
      ]);
      expect(
        beforeKill.sessionEntries.some((entry) =>
          entry.payload_json.includes("preserve-portable-frontier"),
        ),
      ).toBe(true);

      if (boundary === "AH17AfterCheckpointEpochCommit") {
        const checkpoint = JSON.parse(
          beforeKill.checkpoints[0]?.payload_json ?? "{}",
        ) as Record<string, unknown>;
        expect(checkpoint).toMatchObject({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          fromEpoch: 0,
          toEpoch: 1,
          opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
          bindingFingerprint: JSON.parse(nativeTurn?.manifest_json ?? "{}")
            .resolvedModelBindingFingerprint,
        });
      }
      expect(fixture.daemonErrors).toEqual([]);
    },
    120_000,
  );
});

describe("AH19 restart binding qualification", () => {
  it.each([
    "AH17BeforeCheckpointEpochCommit",
    "AH17AfterCheckpointEpochCommit",
  ] as const)(
    "recovers ordinary Native source identity at %s without replaying the ProviderTurn",
    async (boundary) => {
      const scenario = await startOrdinaryNativeAtCheckpointBoundary(boundary);
      const { fixture, project, workId, native, reportUrl, childOutput } =
        scenario;
      const executionId = scenario.probe.executionId;
      const nativeTurnId = native.providerTurnId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeRestart = readSnapshot(fixture.databaseFile, ids);
      const nativeRow = beforeRestart.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const manifest = JSON.parse(nativeRow?.manifest_json ?? "{}") as {
        sourceAgentLoopStep?: {
          executionId: string;
          logicalStepNo: number;
          repairAttempt: number;
          providerTurnId: string;
        };
        inputFrontier?: {
          firstSequence: number | null;
          lastSequence: number | null;
        };
      };
      const sourceStep = beforeRestart.steps.find(
        (step) =>
          step.logical_step_no ===
            manifest.sourceAgentLoopStep?.logicalStepNo &&
          step.repair_attempt === manifest.sourceAgentLoopStep?.repairAttempt,
      );
      expect(manifest.sourceAgentLoopStep).toEqual({
        executionId,
        logicalStepNo: sourceStep?.logical_step_no,
        repairAttempt: sourceStep?.repair_attempt,
        providerTurnId: sourceStep?.provider_turn_id,
      });
      expect(beforeRestart.session?.context_epoch).toBe(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeRestart.checkpoints).toHaveLength(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      const providerRequestCount = providerRequests.length;
      const nativeCount = providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ).length;
      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_REPORT_URL: reportUrl,
            ARBOR_AH19_CAPTURE_EXIT: "1",
          },
        })
        .catch((error: unknown) => {
          throw new Error(
            `ordinary Native daemon restart failed: ${error instanceof Error ? error.message : String(error)} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19_CHILD_EXIT") || line.includes("AH19_CHILD_START")))} lease=${JSON.stringify(readSnapshot(fixture.databaseFile, ids).leases)} turns=${JSON.stringify(
              readSnapshot(fixture.databaseFile, ids).providerTurns.map(
                ({
                  provider_turn_id,
                  context_epoch,
                  settled_at,
                  finish_reason,
                  output_contract_ref,
                  manifest_json,
                }) => ({
                  provider_turn_id,
                  context_epoch,
                  settled_at,
                  finish_reason,
                  output_contract_ref,
                  sourceAgentLoopStep: (() => {
                    try {
                      return (
                        JSON.parse(manifest_json ?? "{}") as Record<
                          string,
                          unknown
                        >
                      ).sourceAgentLoopStep;
                    } catch {
                      return "invalid";
                    }
                  })(),
                }),
              ),
            )} session=${JSON.stringify(readSnapshot(fixture.databaseFile, ids).session)} steps=${JSON.stringify(readSnapshot(fixture.databaseFile, ids).steps)}`,
          );
        });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      const resumedSnapshot = readSnapshot(fixture.databaseFile, ids);
      if (providerRequests.length <= providerRequestCount) {
        throw new Error(
          `ordinary Native restart stalled: requests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, bindingVariant }) => ({ operationKind, providerTurnId, bindingVariant })))} daemonErrors=${JSON.stringify(fixture.daemonErrors)} probes=${JSON.stringify(childOutput.filter((line) => line.includes("AH19NativeCheckpointRecovery") || line.includes("AH19_CHILD_ERROR")))} sessionEpoch=${resumedSnapshot.session?.context_epoch} lease=${JSON.stringify(resumedSnapshot.leases)}`,
        );
      }
      const resumedInference = providerRequests.find(
        (request) =>
          request.operationKind === "Inference" &&
          request.providerTurnId ===
            manifest.sourceAgentLoopStep?.providerTurnId,
      );
      expect(resumedSnapshot.checkpoints).toHaveLength(1);
      expect(
        resumedInference,
        `expected source inference ${manifest.sourceAgentLoopStep?.providerTurnId}; requests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId }) => ({ operationKind, providerTurnId })))}`,
      ).toBeDefined();
      expect(resumedInference?.items ?? []).toContainEqual(
        expect.objectContaining({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
        }),
      );
      expect(
        providerRequests.filter(
          (request) => request.operationKind === "CompactionNative",
        ),
      ).toHaveLength(1);
      expect(
        providerRequests.filter(
          (request) => request.providerTurnId === nativeTurnId,
        ),
      ).toHaveLength(nativeCount);
      expect(providerRequests.length).toBeGreaterThanOrEqual(
        providerRequestCount,
      );
      expect(resumedSnapshot.steps).toContainEqual(
        expect.objectContaining({
          logical_step_no: manifest.sourceAgentLoopStep?.logicalStepNo,
          repair_attempt: manifest.sourceAgentLoopStep?.repairAttempt,
          provider_turn_id: manifest.sourceAgentLoopStep?.providerTurnId,
        }),
      );
      expect(resumedSnapshot.checkpoints[0]?.source_ref).toBe(nativeTurnId);
      expect(
        resumedSnapshot.providerLinks.some(
          (link) =>
            link.provider_turn_id === nativeTurnId &&
            link.role === "OverflowCompaction",
        ),
      ).toBe(false);
      expect(fixture.daemonErrors).toEqual([]);
      expect(manifest.inputFrontier).toMatchObject({
        firstSequence: expect.any(Number),
        lastSequence: expect.any(Number),
      });
    },
    120_000,
  );

  it("rebases ordinary Native recovery from binding A to B through its portable frontier", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = native.providerTurnId;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeRestart = readSnapshot(fixture.databaseFile, ids);
    const nativeRow = beforeRestart.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    const nativeManifest = JSON.parse(nativeRow?.manifest_json ?? "{}") as {
      inputFrontier?: {
        firstSequence: number | null;
        lastSequence: number | null;
      };
      contextRefs?: ReadonlyArray<string>;
      sourceAgentLoopStep?: {
        providerTurnId: string;
        logicalStepNo: number;
        repairAttempt: number;
      };
    };
    expect(nativeRow).toBeDefined();
    expect(beforeRestart.session?.context_epoch).toBe(1);
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const requestsBeforeRestart = providerRequests.length;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CAPTURE_EXIT: "1",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    await waitForPublic(
      async () => ({
        summary: providerRequests.find(
          (request) =>
            request.operationKind === "CompactionSummary" &&
            request.bindingVariant === "B" &&
            providerRequests.indexOf(request) >= requestsBeforeRestart,
        ),
        inference: providerRequests.find(
          (request) =>
            request.operationKind === "Inference" &&
            request.bindingVariant === "B" &&
            request.providerTurnId ===
              nativeManifest.sourceAgentLoopStep?.providerTurnId,
        ),
      }),
      (state) => state.summary !== undefined && state.inference !== undefined,
      60_000,
    ).catch((error: unknown) => {
      const after = readSnapshot(fixture.databaseFile, ids);
      throw new Error(
        `ordinary Native B rebase failed: ${error instanceof Error ? error.message : String(error)} requests=${JSON.stringify(providerRequests.slice(requestsBeforeRestart).map(({ operationKind, providerTurnId, bindingVariant, items }) => ({ operationKind, providerTurnId, bindingVariant, items })))} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19_CHILD_EXIT") || line.includes("AH19NativeCheckpointRecovery")))} session=${JSON.stringify(after.session)} checkpoints=${JSON.stringify(after.checkpoints)} steps=${JSON.stringify(after.steps)}`,
      );
    });
    const after = readSnapshot(fixture.databaseFile, ids);
    const summaryRow = after.providerTurns.find(
      (turn) =>
        turn.output_contract_ref === "compaction-result-v1" &&
        turn.provider_turn_id !== nativeTurnId,
    );
    const summaryManifest = JSON.parse(summaryRow?.manifest_json ?? "{}") as {
      operationKind?: string;
      resolvedModelBindingFingerprint?: string;
      inputFrontier?: {
        firstSequence: number | null;
        lastSequence: number | null;
      };
      contextRefs?: ReadonlyArray<string>;
      sourceAgentLoopStep?: unknown;
    };
    expect(summaryManifest.operationKind).toBe("CompactionSummary");
    expect(summaryManifest.inputFrontier).toEqual(nativeManifest.inputFrontier);
    expect(summaryManifest.contextRefs).toEqual(nativeManifest.contextRefs);
    expect(summaryManifest.sourceAgentLoopStep).toEqual(
      expect.objectContaining({
        logicalStepNo: nativeManifest.sourceAgentLoopStep?.logicalStepNo,
        repairAttempt: nativeManifest.sourceAgentLoopStep?.repairAttempt,
        providerTurnId: nativeManifest.sourceAgentLoopStep?.providerTurnId,
      }),
    );
    const bRequests = providerRequests
      .slice(requestsBeforeRestart)
      .filter((request) => request.bindingVariant === "B");
    expect(
      bRequests.some((request) => request.operationKind === "CompactionNative"),
    ).toBe(false);
    expect(
      bRequests.every((request) =>
        request.items.every(
          (item) =>
            item._tag !== "CompactionCheckpoint" ||
            item.implementation !== "ProviderNative",
        ),
      ),
    ).toBe(true);
    expect(
      bRequests.filter((request) => request.providerTurnId === nativeTurnId),
    ).toHaveLength(0);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(after.checkpoints).toHaveLength(2);
    expect(after.checkpoints[0]?.source_ref).toBe(nativeTurnId);
    expect(fixture.daemonErrors).toEqual([]);
  }, 120_000);

  it("fails closed when ordinary Native startup has two same-epoch candidates", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, childOutput } = scenario;
    const ids = {
      sessionId: project.rootSessionId,
      executionId: probe.executionId,
      workId,
    };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toHaveLength(0);
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === native.providerTurnId,
      ),
    ).toMatchObject({
      settled_at: expect.any(String),
      finish_reason: "Stop",
      output_contract_ref: "provider-native-compaction-v1",
    });
    expect(
      beforeKill.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === native.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      probe.executionId,
      workId,
    );
    const appended = appendSecondOrdinaryNativeCandidate(
      fixture.databaseFile,
      native.providerTurnId,
    );
    expect(appended.candidateCount).toBe(2);
    const beforeRestart = readSnapshot(fixture.databaseFile, ids);
    const requestsBeforeRestart = providerRequests.length;
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "A",
          ARBOR_AH19_ORDINARY_WORK: "1",
          ARBOR_AH19_CAPTURE_EXIT: "1",
        },
      })
      .catch(() => undefined);
    const outcome = await waitForPublic(
      async () => ({
        stage: childOutput.find((line) =>
          line.includes("NativeCompactionCandidateAmbiguity:count=2"),
        ),
        snapshot: readSnapshot(fixture.databaseFile, ids),
      }),
      (state) => state.stage !== undefined,
      30_000,
    );
    expect(outcome.stage).toContain(
      "NativeCompactionCandidateAmbiguity:count=2",
    );
    expect(outcome.snapshot.session?.context_epoch).toBe(0);
    expect(outcome.snapshot.checkpoints).toEqual(beforeRestart.checkpoints);
    expect(outcome.snapshot.steps).toEqual(beforeRestart.steps);
    expect(outcome.snapshot.execution?.settled_at).toBeNull();
    expect(providerRequests).toHaveLength(requestsBeforeRestart);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === native.providerTurnId,
      ),
    ).toHaveLength(1);
  }, 150_000);

  it.each(["firstSequence", "lastSequence"] as const)(
    "fails closed after restart when an ordinary Native frontier has only %s null",
    async (nullSide) => {
      const scenario = await startOrdinaryNativeAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const { fixture, project, workId, native, probe, childOutput } = scenario;
      const ids = {
        sessionId: project.rootSessionId,
        executionId: probe.executionId,
        workId,
      };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(beforeKill.session?.context_epoch).toBe(1);
      expect(beforeKill.checkpoints).toHaveLength(1);
      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        probe.executionId,
        workId,
      );
      corruptNativeManifestFrontierHalfNull(
        fixture.databaseFile,
        native.providerTurnId,
        nullSide,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      const changedTurn = corrupted.providerTurns.find(
        (turn) => turn.provider_turn_id === native.providerTurnId,
      );
      const frontier = JSON.parse(changedTurn?.manifest_json ?? "{}")
        .inputFrontier as {
        firstSequence: number | null;
        lastSequence: number | null;
      };
      expect(frontier[nullSide]).toBeNull();
      expect(
        frontier[
          nullSide === "firstSequence" ? "lastSequence" : "firstSequence"
        ],
      ).toEqual(expect.any(Number));
      const requestsBeforeRestart = providerRequests.length;
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_ORDINARY_WORK: "1",
            ARBOR_AH19_CAPTURE_EXIT: "1",
          },
        })
        .catch(() => undefined);
      const outcome = await waitForPublic(
        async () => ({
          stage: childOutput.find((line) =>
            line.includes(
              "NativeCheckpointEvidence:frontier=false:source=true",
            ),
          ),
          snapshot: readSnapshot(fixture.databaseFile, ids),
        }),
        (state) => state.stage !== undefined,
        30_000,
      );
      expect(outcome.stage).toContain(
        "NativeCheckpointEvidence:frontier=false:source=true",
      );
      expect(outcome.snapshot.session?.context_epoch).toBe(1);
      expect(outcome.snapshot.checkpoints).toEqual(beforeKill.checkpoints);
      expect(outcome.snapshot.steps).toEqual(beforeKill.steps);
      expect(outcome.snapshot.execution?.settled_at).toBeNull();
      expect(providerRequests).toHaveLength(requestsBeforeRestart);
    },
    150_000,
  );

  it.each(["WorkStartup", "ConversationCommon"] as const)(
    "fails closed at %s when the checkpoint owner is NextStepReady without a successor",
    async (route) => {
      const scenario =
        route === "WorkStartup"
          ? await startOrdinaryNativeAtCheckpointBoundary(
              "AH17AfterCheckpointEpochCommit",
            )
          : await startAtCheckpointBoundary(
              "AH17AfterCheckpointEpochCommit",
              {},
              "ConversationResponse",
            );
      const { fixture, project, workId, childOutput } = scenario;
      const executionId = scenario.probe.executionId;
      const nativeTurnId =
        "native" in scenario
          ? scenario.native.providerTurnId
          : scenario.probe.providerTurnId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const before = readSnapshot(fixture.databaseFile, ids);
      const nativeRow = before.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const manifest = JSON.parse(nativeRow?.manifest_json ?? "{}") as {
        sourceAgentLoopStep?: { logicalStepNo: number; repairAttempt: number };
      };
      const source = manifest.sourceAgentLoopStep;
      expect(source).toBeDefined();
      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      markStepNextReadyWithoutSuccessor(
        fixture.databaseFile,
        executionId,
        source?.logicalStepNo ?? -1,
        source?.repairAttempt ?? -1,
      );
      const requestsBeforeRestart = providerRequests.length;
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ...(route === "WorkStartup"
              ? { ARBOR_AH19_ORDINARY_WORK: "1" }
              : {}),
            ARBOR_AH19_CAPTURE_EXIT: "1",
            ...(scenario.reportUrl === undefined
              ? {}
              : { ARBOR_AH19_REPORT_URL: scenario.reportUrl }),
          },
        })
        .catch(() => undefined);
      const outcome = await waitForPublic(
        async () => {
          const childError = childOutput
            .map((line) => {
              try {
                return JSON.parse(line) as {
                  tag?: string;
                  error?: { reason?: string };
                };
              } catch {
                return undefined;
              }
            })
            .find((event) => event?.tag === "AH19_CHILD_ERROR");
          return {
            childError,
            requests: providerRequests.length - requestsBeforeRestart,
          };
        },
        (state) => state.childError !== undefined || state.requests > 0,
        20_000,
      );
      expect(outcome.childError?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );
      expect(outcome.requests).toBe(0);
      const after = readSnapshot(fixture.databaseFile, ids);
      expect(after.session?.context_epoch).toBe(1);
      expect(after.checkpoints).toEqual(before.checkpoints);
      expect(after.execution?.settled_at).toBeNull();
      expect(after.steps).toContainEqual(
        expect.objectContaining({
          logical_step_no: source?.logicalStepNo,
          repair_attempt: source?.repairAttempt,
          state: "NextStepReady",
          successor_json: null,
        }),
      );
    },
    150_000,
  );

  it("routes an overflow-linked Native receipt through P20 before a changed-binding rebase", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = probe.providerTurnId;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const nativeLink = beforeKill.providerLinks.find(
      (link) => link.provider_turn_id === nativeTurnId,
    );
    expect(nativeLink).toMatchObject({
      logical_step_no: 1,
      repair_attempt: 0,
      role: "OverflowCompaction",
      overflow_ordinal: 0,
    });
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toMatchObject({
      settled_at: expect.any(String),
      finish_reason: "Stop",
      output_contract_ref: "provider-native-compaction-v1",
    });
    expect(
      beforeKill.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([expect.objectContaining({ attempt_no: 0, outcome: "Success" })]);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toHaveLength(0);
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const requestCountBeforeRestart = providerRequests.length;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_REPORT_URL: reportUrl,
        ARBOR_AH19_CAPTURE_EXIT: "1",
      },
    });
    const resumed = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.workWait !== undefined,
      60_000,
    ).catch((error: unknown) => {
      const snapshot = readSnapshot(fixture.databaseFile, ids);
      throw new Error(
        `P20 Native source was not recovered before portable rebase: ${error instanceof Error ? error.message : String(error)} requests=${JSON.stringify(providerRequests.slice(requestCountBeforeRestart).map(({ operationKind, providerTurnId, bindingVariant, items }) => ({ operationKind, providerTurnId, bindingVariant, items })))} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19NativeCheckpointRecovery")))} session=${JSON.stringify(snapshot.session)} checkpoints=${JSON.stringify(snapshot.checkpoints)} links=${JSON.stringify(snapshot.providerLinks)} steps=${JSON.stringify(snapshot.steps)}`,
      );
    });
    expect(resumed.checkpoints).toHaveLength(1);
    expect(resumed.providerLinks).toContainEqual(nativeLink);
    expect(resumed.providerLinks).toContainEqual(
      expect.objectContaining({
        logical_step_no: nativeLink?.logical_step_no,
        repair_attempt: nativeLink?.repair_attempt,
        role: "OverflowReplacement",
        predecessor_provider_turn_id: nativeTurnId,
        context_epoch: 1,
      }),
    );
    expect(resumed.checkpoints[0]?.source_ref).not.toBe(nativeTurnId);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ),
    ).toHaveLength(1);
    const bindingBRequests = providerRequests
      .slice(requestCountBeforeRestart)
      .filter((request) => request.bindingVariant === "B");
    expect(
      bindingBRequests.some(
        (request) => request.operationKind === "CompactionNative",
      ),
    ).toBe(false);
    expect(
      bindingBRequests.every((request) =>
        request.items.every(
          (item) =>
            item._tag !== "CompactionCheckpoint" ||
            item.implementation !== "ProviderNative",
        ),
      ),
    ).toBe(true);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);

  it.each([
    "logicalStepNo",
    "repairAttempt",
    "providerTurnId",
    "executionId",
    "bindingFingerprint",
  ] as const)(
    "fails closed on an ordinary Native manifest with corrupted %s evidence",
    async (field) => {
      const scenario = await startOrdinaryNativeAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const { fixture, project, workId, native, probe, childOutput } = scenario;
      const executionId = probe.executionId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const originalNativeRow = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === native.providerTurnId,
      );
      expect(beforeKill.session?.context_epoch).toBe(1);
      expect(beforeKill.checkpoints).toHaveLength(1);
      expect(
        beforeKill.providerLinks.some(
          (link) =>
            link.provider_turn_id === native.providerTurnId &&
            link.role === "OverflowCompaction",
        ),
      ).toBe(false);
      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptOrdinaryNativeSourceIdentity(
        fixture.databaseFile,
        native.providerTurnId,
        field,
      );
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "B",
            ARBOR_AH19_CAPTURE_EXIT: "1",
          },
        })
        .catch(() => undefined);
      const childError = await waitForPublic(
        async () =>
          childOutput
            .map((line) => {
              try {
                return JSON.parse(line) as {
                  tag?: string;
                  error?: { reason?: string };
                };
              } catch {
                return undefined;
              }
            })
            .find((event) => event?.tag === "AH19_CHILD_ERROR"),
        (event) => event !== undefined,
        20_000,
      );
      expect(childError?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );
      const rejected = readSnapshot(fixture.databaseFile, ids);
      expect(rejected.session?.context_epoch).toBe(1);
      expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
      expect(
        rejected.providerTurns.find(
          (turn) => turn.provider_turn_id === native.providerTurnId,
        ),
      ).toMatchObject({
        manifest_id: originalNativeRow?.manifest_id,
        settled_at: originalNativeRow?.settled_at,
      });
      expect(rejected.execution?.settled_at).toBeNull();
      expect(rejected.leases.at(-1)?.generation).toBe(1);
      expect(
        providerRequests.filter((request) => request.bindingVariant === "B"),
      ).toHaveLength(0);
      expect(fixture.daemonErrors).toEqual([]);
    },
    160_000,
  );

  it.each(["compiledRequestHash", "contextEpoch"] as const)(
    "rejects ordinary Native recovery at the manifest %s check after process loss",
    async (field) => {
      const scenario = await startOrdinaryNativeAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const {
        fixture,
        project,
        workId,
        native,
        probe,
        childOutput,
        reportUrl,
      } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = native.providerTurnId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const nativeBeforeKill = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const nativeManifestBeforeKill = JSON.parse(
        nativeBeforeKill?.manifest_json ?? "{}",
      ) as Record<string, unknown>;
      const nativeCheckpointBeforeKill = JSON.parse(
        beforeKill.checkpoints[0]?.payload_json ?? "{}",
      ) as Record<string, unknown>;
      const portableRequestBeforeKill =
        nativeBeforeKill?.portable_request_json ?? "";
      expect(beforeKill.session?.context_epoch).toBe(1);
      expect(beforeKill.checkpoints).toHaveLength(1);
      expect(beforeKill.checkpoints[0]?.source_ref).toBe(nativeTurnId);
      expect(nativeManifestBeforeKill.contextEpoch).toBe(
        nativeCheckpointBeforeKill.fromEpoch,
      );
      expect(nativeManifestBeforeKill.compiledRequestHash).toBe(
        createHash("sha256").update(portableRequestBeforeKill).digest("hex"),
      );
      expect(nativeBeforeKill).toMatchObject({
        context_epoch: 0,
        output_contract_ref: "provider-native-compaction-v1",
        settled_at: expect.any(String),
        finish_reason: "Stop",
      });
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(
        beforeKill.providerLinks.some(
          (link) => link.provider_turn_id === nativeTurnId,
        ),
      ).toBe(false);
      const nativeRequestCount = providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ).length;
      expect(nativeRequestCount).toBe(1);

      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      const corruption = corruptOrdinaryNativeManifestField(
        fixture.databaseFile,
        nativeTurnId,
        field,
      );
      const corruptedSnapshot = readSnapshot(fixture.databaseFile, ids);
      const corruptedNative = corruptedSnapshot.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(corruptedNative?.portable_request_json).toBe(
        corruption.portableRequestJson,
      );
      expect(JSON.parse(corruptedNative?.manifest_json ?? "{}")[field]).toBe(
        corruption.corruptedValue,
      );
      const corruptedNativeManifest = JSON.parse(
        corruptedNative?.manifest_json ?? "{}",
      ) as Record<string, unknown>;
      expect({
        ...corruptedNativeManifest,
        [field]: nativeManifestBeforeKill[field],
      }).toEqual(nativeManifestBeforeKill);
      expect(corruptedSnapshot.session?.context_epoch).toBe(1);
      expect(corruptedSnapshot.checkpoints).toEqual(beforeKill.checkpoints);

      const requestsBeforeRestart = providerRequests.length;
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_ORDINARY_WORK: "1",
            ARBOR_AH19_REPORT_URL: reportUrl,
            ARBOR_AH19_CAPTURE_EXIT: "1",
          },
        })
        .catch(() => undefined);

      const rejection = await waitForPublic(
        async () => {
          const stageLine = childOutput.find((line) =>
            line.includes("NativeStartupManifestChecks:"),
          );
          const childError = childOutput
            .map((line) => {
              try {
                return JSON.parse(line) as {
                  tag?: string;
                  error?: { reason?: string };
                };
              } catch {
                return undefined;
              }
            })
            .find((event) => event?.tag === "AH19_CHILD_ERROR");
          return { stageLine, childError };
        },
        (state) =>
          state.stageLine !== undefined && state.childError !== undefined,
        30_000,
      );
      const diagnostic = JSON.parse(rejection.stageLine ?? "{}") as {
        stage?: string;
      };
      const checkValues = Object.fromEntries(
        (diagnostic.stage ?? "")
          .slice("NativeStartupManifestChecks:".length)
          .split(",")
          .map((check) => check.split("=")),
      );
      expect(checkValues).toEqual({
        checkpoint: "true",
        providerTurn: "true",
        execution: "true",
        session: "true",
        source: "true",
        step: "true",
        sourceProviderTurn: "true",
        stepState: "true",
        sourceLinkAbsent: "true",
        frontier: "true",
        receipt: "true",
        operation: "true",
        bindingFingerprint: "true",
        contextEpoch: field === "contextEpoch" ? "false" : "true",
        compiledRequestHash: field === "compiledRequestHash" ? "false" : "true",
      });
      expect(rejection.childError?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );

      const rejected = readSnapshot(fixture.databaseFile, ids);
      expect(rejected.leases.at(-1)?.generation).toBe(1);
      expect(rejected.session?.context_epoch).toBe(1);
      expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
      expect(rejected.steps).toEqual(beforeKill.steps);
      expect(rejected.execution).toEqual(beforeKill.execution);
      expect(
        rejected.providerTurns.filter(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toHaveLength(1);
      expect(
        rejected.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(providerRequests).toHaveLength(requestsBeforeRestart);
      expect(
        providerRequests.filter(
          (request) => request.providerTurnId === nativeTurnId,
        ),
      ).toHaveLength(nativeRequestCount);
    },
    150_000,
  );

  it("fails closed rather than sending an older Native opaque checkpoint to a changed binding", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(targetNativeTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(beforeKill.checkpoints[0]?.source_ref).toBe(olderNativeTurnId);
    const olderCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(olderCheckpoint.opaqueItemRef).toBe(olderOpaqueRef);
    const targetNativeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === targetNativeTurnId,
    );
    expect(targetNativeTurn).toMatchObject({
      settled_at: expect.any(String),
      output_contract_ref: "provider-native-compaction-v1",
    });
    const targetNativeRequest = JSON.parse(
      targetNativeTurn?.portable_request_json ?? "{}",
    ) as { inputItems?: ReadonlyArray<Record<string, unknown>> };
    expect(
      targetNativeRequest.inputItems?.filter(
        (item) =>
          item._tag === "CompactionCheckpoint" &&
          item.implementation === "ProviderNative",
      ),
    ).toEqual([
      expect.objectContaining({
        implementation: "ProviderNative",
        opaqueItemRef: olderOpaqueRef,
      }),
    ]);
    expect(
      beforeKill.providerLinks.filter(
        (link) => link.provider_turn_id === targetNativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        logical_step_no: 2,
        repair_attempt: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_2`,
        context_epoch: 1,
      }),
    ]);
    const olderReplacementLink = beforeKill.providerLinks.find(
      (link) =>
        link.logical_step_no === 1 && link.role === "OverflowReplacement",
    );
    expect(olderReplacementLink).toMatchObject({
      provider_turn_id: `ptn_${executionId}_1_overflow_0`,
      predecessor_provider_turn_id: olderNativeTurnId,
      context_epoch: 1,
    });

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session?.context_epoch).toBe(1);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    expect(
      afterKill.providerTurns.find(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toEqual(targetNativeTurn);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const restartFailure = await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_CAPTURE_EXIT: "1",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    if (restartFailure !== null) {
      const childError = childOutput
        .map((line) => {
          try {
            return JSON.parse(line) as {
              tag?: string;
              error?: { reason?: string };
            };
          } catch {
            return undefined;
          }
        })
        .find((event) => event?.tag === "AH19_CHILD_ERROR");
      expect(
        childError?.error?.reason,
        `unexpected nested restart failure: ${restartFailure instanceof Error ? restartFailure.message : String(restartFailure)}; child=${childOutput.join(" | ")}`,
      ).toBe("AgentLoopStepReplayBindingMismatch");
      expect(
        providerRequests.some(
          (request) =>
            request.bindingVariant === "B" &&
            request.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
        ),
      ).toBe(false);
    }
    const recovery = await waitForPublic(
      async () => ({
        resumedSuccessor: childOutput.some((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
              providerTurnId?: string;
            };
            return (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage ===
                `NativeRebaseResumesPersistedSuccessor:from=1:to=2:providerTurn=ptn_${executionId}_2` &&
              event.providerTurnId === olderNativeTurnId
            );
          } catch {
            return false;
          }
        }),
        nestedRejected: childOutput.some((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
              providerTurnId?: string;
            };
            return (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage === "NestedNativeFrontierRejected" &&
              event.providerTurnId === targetNativeTurnId
            );
          } catch {
            return false;
          }
        }),
        leakedRequest: providerRequests.find(
          (event) =>
            event.bindingVariant === "B" &&
            event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
        ),
      }),
      (state) =>
        state.resumedSuccessor ||
        state.nestedRejected ||
        state.leakedRequest !== undefined,
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 nested Native rebase did not reach a bounded decision: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(recovery.resumedSuccessor).toBe(true);
    expect(recovery.nestedRejected).toBe(true);
    expect(recovery.leakedRequest).toBeUndefined();
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
      ),
    ).toEqual([]);
    const afterRejection = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRejection.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
  }, 180_000);

  it("fails closed when the persisted NextStepReady successor does not point back to its source", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    const targetStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 2 && step.repair_attempt === 0,
    );
    expect(sourceStep?.state).toBe("NextStepReady");
    expect(JSON.parse(sourceStep?.successor_json ?? "{}")).toMatchObject({
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    expect(targetStep).toMatchObject({
      predecessor_logical_step_no: 1,
      predecessor_repair_attempt: 0,
    });

    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptStepSuccessorPredecessor(fixture.databaseFile, executionId);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    expect(
      corrupted.steps.find((step) => step.logical_step_no === 2),
    ).toMatchObject({
      predecessor_logical_step_no: 0,
      predecessor_repair_attempt: 0,
    });

    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const successorCheckStage = await waitForPublic(
      async () =>
        childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                boundary?: string;
                stage?: string;
                providerTurnId?: string;
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage?.startsWith("NativeRebaseSuccessorChecks:") ===
                true &&
              event.stage.includes("predecessorStep=false") &&
              event.providerTurnId === olderNativeTurnId,
          ),
      (event) => event !== undefined,
      45_000,
    );
    expect(successorCheckStage?.stage).toContain("predecessorStep=false");
    expect(
      childOutput.some((line) =>
        line.includes("NativeRebaseResumesPersistedSuccessor"),
      ),
    ).toBe(false);
    const leakedRequests = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
    );
    expect(leakedRequests).toEqual([]);
    const afterRestart = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRestart.providerTurns.find(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toBeDefined();
    expect(
      afterRestart.checkpoints.some(
        (checkpoint) => checkpoint.source_ref === targetNativeTurnId,
      ),
    ).toBe(false);
  }, 180_000);

  it("fails closed when the persisted NextStepReady successor skips a logical step", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(sourceStep?.state).toBe("NextStepReady");
    expect(JSON.parse(sourceStep?.successor_json ?? "{}")).toMatchObject({
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptStepSuccessorLogicalStepNo(fixture.databaseFile, executionId);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    expect(
      JSON.parse(
        corrupted.steps.find((step) => step.logical_step_no === 1)
          ?.successor_json ?? "{}",
      ).logicalStepNo,
    ).toBe(3);

    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const successorCheckStage = await waitForPublic(
      async () =>
        childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                boundary?: string;
                stage?: string;
                providerTurnId?: string;
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage?.startsWith("NativeRebaseSuccessorChecks:") ===
                true &&
              event.stage.includes("exactNextStep=false") &&
              event.providerTurnId === olderNativeTurnId,
          ),
      (event) => event !== undefined,
      45_000,
    );
    expect(successorCheckStage?.stage).toContain("exactNextStep=false");
    expect(
      childOutput.some((line) =>
        line.includes("NativeRebaseResumesPersistedSuccessor"),
      ),
    ).toBe(false);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
      ),
    ).toEqual([]);
    const afterRestart = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRestart.providerTurns.some(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toBe(true);
    expect(
      afterRestart.checkpoints.some(
        (checkpoint) => checkpoint.source_ref === targetNativeTurnId,
      ),
    ).toBe(false);
  }, 180_000);

  it("rebases a StepEffectsCommitted Native source to its exact next successor without replaying effects", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_AH11_MATCH_INDEX: "2",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_1`;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const replacementTurnId = `ptn_${executionId}_1_overflow_0`;
    const replacementCallRef = `call_ah19_plan_${replacementTurnId.replaceAll(/[^a-zA-Z0-9]/gu, "_")}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(sourceInferenceTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(beforeKill.checkpoints[0]?.source_ref).toBe(olderNativeTurnId);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 1,
    });
    const olderReplacementLink = beforeKill.providerLinks.find(
      (link) =>
        link.logical_step_no === 1 && link.role === "OverflowReplacement",
    );
    expect(olderReplacementLink).toMatchObject({
      provider_turn_id: replacementTurnId,
      predecessor_provider_turn_id: olderNativeTurnId,
      context_epoch: 1,
    });
    const sourceAction = beforeKill.actions.filter(
      (action) => action.logical_step_no === 1 && action.repair_attempt === 0,
    );
    expect(sourceAction).toHaveLength(1);
    expect(sourceAction[0]).toMatchObject({
      call_ref: replacementCallRef,
      action_kind: "update_plan",
      state: "Applied",
    });
    expect(
      beforeKill.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          entry.payload_json.includes(replacementCallRef),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.providerTurnId === sourceInferenceTurnId,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.providerTurnId === replacementTurnId,
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.steps.find((step) => step.logical_step_no === 1)).toEqual(
      sourceStep,
    );
    expect(
      afterKill.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    const converged = await waitForPublic(
      async () => {
        const snapshot = readSnapshot(fixture.databaseFile, ids);
        const resumedStep = snapshot.steps.find(
          (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
        );
        const childFailure = childOutput.some((line) => {
          try {
            return (
              (JSON.parse(line) as { tag?: string }).tag === "AH19_CHILD_ERROR"
            );
          } catch {
            return false;
          }
        });
        return { snapshot, resumedStep, childFailure };
      },
      (state) =>
        state.resumedStep?.state === "NextStepReady" || state.childFailure,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 StepEffectsCommitted successor did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(
      converged.childFailure,
      `AH19 StepEffectsCommitted RED snapshot=${JSON.stringify({
        sessionEpoch: converged.snapshot.session?.context_epoch,
        checkpoints: converged.snapshot.checkpoints.map((entry) => ({
          sourceRef: entry.source_ref,
          payload: entry.payload_json,
        })),
        steps: converged.snapshot.steps.map((step) => ({
          step: step.logical_step_no,
          repair: step.repair_attempt,
          state: step.state,
          successor: step.successor_json,
        })),
        replacementLink: converged.snapshot.providerLinks.find(
          (link) =>
            link.logical_step_no === 1 && link.role === "OverflowReplacement",
        ),
        child: childOutput.filter(
          (line) =>
            line.includes("AH19NativeCheckpointRecovery") ||
            line.includes("AH19_CHILD_ERROR"),
        ),
        bindingBRequests: providerRequests.filter(
          (event) => event.bindingVariant === "B",
        ),
      })}`,
    ).toBe(false);
    const successorProgress = await waitForPublic(
      async () => ({
        snapshot: readSnapshot(fixture.databaseFile, ids),
        successorRequested: providerRequests.some(
          (event) =>
            event.bindingVariant === "B" &&
            event.operationKind === "Inference" &&
            event.providerTurnId === `ptn_${executionId}_2`,
        ),
      }),
      (state) =>
        state.successorRequested || state.snapshot.workWait !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 StepEffectsCommitted successor did not run: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}`,
      );
    });
    const finalSnapshot = successorProgress.snapshot;
    const resumedStep = finalSnapshot.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(resumedStep?.state).toBe("NextStepReady");
    const successor = JSON.parse(resumedStep?.successor_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(successor).toMatchObject({
      executionId,
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    expect(
      finalSnapshot.steps.find(
        (step) => step.logical_step_no === 2 && step.repair_attempt === 0,
      )?.predecessor_logical_step_no,
    ).toBe(1);
    expect(finalSnapshot.session?.context_epoch).toBe(2);
    expect(finalSnapshot.checkpoints).toHaveLength(2);
    expect(
      finalSnapshot.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
    expect(
      finalSnapshot.actions.filter((action) => action.logical_step_no === 1),
    ).toEqual(sourceAction);
    expect(
      finalSnapshot.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          entry.payload_json.includes(replacementCallRef),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "A" &&
          [sourceInferenceTurnId, replacementTurnId].includes(
            event.providerTurnId,
          ),
      ),
    ).toHaveLength(2);
    const bindingBSummary = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.operationKind === "CompactionSummary",
    );
    expect(bindingBSummary).toHaveLength(1);
    expect(
      bindingBSummary[0]?.items.filter(
        (item) => item.opaqueItemRef !== undefined,
      ),
    ).toEqual([]);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.operationKind === "Inference" &&
          event.providerTurnId === `ptn_${executionId}_2`,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.providerTurnId === replacementTurnId,
      ),
    ).toEqual([]);
    expect(
      providerRequests.some(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some(
            (item) => item.opaqueItemRef === `ah19-opaque:${olderNativeTurnId}`,
          ),
      ),
    ).toBe(false);
  }, 180_000);

  it("settles a terminal ConversationResponse from its pinned StepEffectsCommitted output after Native rebase", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      { ARBOR_AH19_AH11_MATCH_INDEX: "1" },
      "ConversationResponse",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const nativeTurnId = `ptn_${executionId}_0_native_compact_0`;
    const replacementTurnId = `ptn_${executionId}_0_overflow_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(sourceInferenceTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const responseJob = beforeKill.responseJobs[0];
    expect(responseJob).toMatchObject({
      state: "Running",
      response_body: null,
      response_execution_id: null,
    });
    expect(beforeKill.execution?.settlement_kind).toBeNull();
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(beforeKill.checkpoints[0]?.source_ref).toBe(nativeTurnId);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 0,
      model_output_session_sequence: expect.any(Number),
      decoded_output_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const sourcedAnswer = beforeKill.sessionEntries.find(
      (entry) =>
        entry.sequence === sourceStep?.model_output_session_sequence &&
        entry.source_ref === `${replacementTurnId}:assistant`,
    );
    expect(sourcedAnswer?.entry_kind).toBe("ModelOutput");
    expect(sourcedAnswer?.item_type).toBe("AssistantMessage");
    expect(sourcedAnswer?.source_ref).toBe(`${replacementTurnId}:assistant`);
    expect(sourcedAnswer?.payload_json).toContain(
      "AH19 recovered terminal conversation answer.",
    );
    expect(beforeKill.actions).toEqual([]);
    expect(
      providerRequests.filter(
        (event) =>
          event.providerTurnId === sourceInferenceTurnId ||
          event.providerTurnId === nativeTurnId ||
          event.providerTurnId === replacementTurnId,
      ),
    ).toHaveLength(3);

    await fixture.crash();
    expect(readSnapshot(fixture.databaseFile, ids).steps).toEqual(
      beforeKill.steps,
    );
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .catch((error: unknown) => {
        const qualification = childOutput.flatMap((line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            return event.tag === "AH19_PROBE"
              ? [`${String(event.boundary)}:${String(event.stage)}`]
              : event.tag === "AH19_CHILD_ERROR"
                ? [
                    `CHILD_ERROR:${String(event.message)}:${String(event.stack ?? "")}`,
                  ]
                : [String(event.tag)];
          } catch {
            return [];
          }
        });
        throw new Error(
          `AH19 ConversationResponse daemon restart failed: ${error instanceof Error ? error.message : String(error)}; qualification=${qualification.join(" | ")}; providerRequests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, bindingVariant, items }) => ({ operationKind, providerTurnId, bindingVariant, opaque: items.filter((item) => item.opaqueItemRef !== undefined).map((item) => item.opaqueItemRef) })))}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids), (_key, value) => (typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}…` : value))}`,
        );
      });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.execution !== undefined &&
        snapshot.execution.settled_at !== null &&
        snapshot.responseJobs.some((job) => job.state === "Answered"),
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 ConversationResponse terminal recovery did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const messageId = responseJob?.message_id;
    expect(messageId).toBeDefined();
    expect(
      recovered.execution,
      `AH19 ConversationResponse terminal mismatch: ${JSON.stringify({
        execution: recovered.execution,
        responseJobs: recovered.responseJobs,
        steps: recovered.steps,
        providerTurns: recovered.providerTurns.map((turn) => ({
          id: turn.provider_turn_id,
          epoch: turn.context_epoch,
          output: turn.output_contract_ref,
          settled: turn.settled_at,
          finish: turn.finish_reason,
        })),
        providerRequests: providerRequests.map((event) => ({
          id: event.providerTurnId,
          op: event.operationKind,
          binding: event.bindingVariant,
        })),
        child: childOutput
          .filter(
            (line) =>
              line.includes("AH19NativeCheckpointRecovery") ||
              line.includes("AH19_CHILD_ERROR"),
          )
          .slice(-12),
      })}`,
    ).toMatchObject({
      execution_id: executionId,
      settlement_kind: "Completed",
    });
    const recoveredStep = recovered.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(recoveredStep?.state).toBe("SettlementProposed");
    expect(recoveredStep?.successor_json).toBeNull();
    expect(recoveredStep?.decoded_output_hash).toBe(
      sourceStep?.decoded_output_hash,
    );
    expect(recoveredStep?.model_output_session_sequence).toBe(
      sourceStep?.model_output_session_sequence,
    );
    expect(recovered.responseJobs).toEqual([
      expect.objectContaining({
        message_id: messageId,
        state: "Answered",
        response_execution_id: executionId,
        response_body: "AH19 recovered terminal conversation answer.",
      }),
    ]);
    expect(
      recovered.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "ModelOutput" &&
          entry.item_type === "AssistantMessage" &&
          entry.source_ref === `${replacementTurnId}:assistant`,
      ),
    ).toEqual([sourcedAnswer]);
    expect(
      recovered.providerTurns.filter(
        (turn) =>
          turn.provider_turn_id === sourceInferenceTurnId ||
          turn.provider_turn_id === nativeTurnId ||
          turn.provider_turn_id === replacementTurnId,
      ),
    ).toHaveLength(3);
    const terminalBindingBSummary = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.operationKind === "CompactionSummary",
    );
    expect(terminalBindingBSummary).toHaveLength(1);
    expect(
      terminalBindingBSummary[0]?.items.some(
        (item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`,
      ),
    ).toBe(false);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);

  it("fails closed on a corrupted compiled hash for the pinned terminal output before Summary", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      { ARBOR_AH19_AH11_MATCH_INDEX: "1" },
      "ConversationResponse",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const replacementTurnId = `ptn_${executionId}_0_overflow_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 0,
    });
    expect(
      beforeKill.sessionEntries.some(
        (entry) =>
          entry.sequence === sourceStep?.model_output_session_sequence &&
          entry.source_ref === `${replacementTurnId}:assistant`,
      ),
    ).toBe(true);
    const nativeCheckpoint = beforeKill.checkpoints[0];
    expect(nativeCheckpoint).toBeDefined();
    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const corrupted = corruptCompiledInferenceRequestHash(
      fixture.databaseFile,
      replacementTurnId,
    );
    expect(corrupted.originalHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(corrupted.corruptedHash).not.toBe(corrupted.originalHash);
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const failedClosed = await waitForPublic(
      async () => {
        const childFailure = childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                error?: { reason?: string };
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_CHILD_ERROR" &&
              event.error?.reason === "AgentLoopStepReplayBindingMismatch",
          );
        return {
          snapshot: readSnapshot(fixture.databaseFile, ids),
          childFailure,
        };
      },
      (value) => value.childFailure !== undefined,
      20_000,
    );
    expect(failedClosed.snapshot.leases[0]?.generation).toBe(1);
    expect(failedClosed.snapshot.session?.context_epoch).toBe(1);
    expect(failedClosed.snapshot.checkpoints).toEqual([nativeCheckpoint]);
    expect(
      failedClosed.snapshot.steps.find(
        (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
      ),
    ).toEqual(sourceStep);
    expect(failedClosed.snapshot.execution?.settlement_kind).toBeNull();
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);

  it("locally settles complete Native success evidence on the same Turn and Manifest after process loss", async () => {
    const scenario = await startAtCheckpointBoundary("AH12BeforeSuccessCommit");
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(nativeTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    const beforeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(beforeTurn).toMatchObject({
      output_contract_ref: "provider-native-compaction-v1",
      settled_at: null,
      finish_reason: null,
      manifest_json: expect.any(String),
      portable_request_json: expect.any(String),
    });
    const beforeAttempt = beforeKill.providerAttempts.find(
      (attempt) => attempt.provider_turn_id === nativeTurnId,
    );
    expect(beforeAttempt).toMatchObject({
      attempt_no: 0,
      outcome: "InProgress",
      delivered_position: 0,
      continuation_checkpoint_json: null,
    });
    const beforeObservation = JSON.parse(
      beforeAttempt?.observation_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeObservation).toEqual({
      responseStarted: true,
      canonicalEventEmitted: true,
      consumerVisibleOutput: false,
      toolCallProposed: false,
      continuationAvailable: true,
      externalEffectPossible: false,
    });
    const completePrefix = JSON.parse(
      beforeAttempt?.canonical_event_prefix_json ?? "[]",
    ) as Array<{ _tag?: string; finishReason?: string; stateRef?: string }>;
    expect(completePrefix.map((event) => event._tag)).toEqual([
      "TurnStarted",
      "ContinuationState",
      "TurnCompleted",
    ]);
    expect(completePrefix.at(-1)?.finishReason).toBe("Stop");
    expect(completePrefix[1]?.stateRef).toBe(`ah19-opaque:${nativeTurnId}`);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toEqual([
      expect.objectContaining({
        providerTurnId: nativeTurnId,
        bindingVariant: "A",
      }),
    ]);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toEqual(beforeTurn);
    expect(afterKill.providerAttempts).toEqual(beforeKill.providerAttempts);
    expect(afterKill.checkpoints).toEqual([]);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });

    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 unsettled Native Turn did not recover: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${scenario.childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recoveredNativeTurn = recovered.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(recoveredNativeTurn?.manifest_id).toBe(beforeTurn?.manifest_id);
    expect(recoveredNativeTurn?.manifest_json).toBe(beforeTurn?.manifest_json);
    expect(recoveredNativeTurn?.portable_request_json).toBe(
      beforeTurn?.portable_request_json,
    );
    expect(recoveredNativeTurn?.output_contract_ref).toBe(
      "provider-native-compaction-v1",
    );
    expect(recoveredNativeTurn?.finish_reason).toBe("Stop");
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_no: 0,
        outcome: "Success",
        delivered_position: completePrefix.length,
      }),
    ]);
    const nativeRequests = providerRequests.filter(
      (event) => event.operationKind === "CompactionNative",
    );
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests.map((event) => event.providerTurnId)).toEqual([
      nativeTurnId,
    ]);
    expect(
      recovered.checkpoints.filter(
        (entry) => entry.source_ref === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);

  it.each([
    "truncated",
    "duplicate-terminal",
    "invalid-continuation",
    "identity-mismatch",
  ] as const)(
    "does not locally settle Native success when its canonical prefix is %s",
    async (corruption) => {
      const scenario = await startAtCheckpointBoundary(
        "AH12BeforeSuccessCommit",
      );
      const { fixture, project, workId, probe, reportUrl } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const beforeTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const beforeAttempt = beforeKill.providerAttempts.find(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      );
      expect(beforeTurn).toMatchObject({
        output_contract_ref: "provider-native-compaction-v1",
        settled_at: null,
        manifest_json: expect.any(String),
      });
      expect(beforeAttempt).toMatchObject({
        outcome: "InProgress",
        delivered_position: 0,
      });

      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptNativeSuccessPrefix(
        fixture.databaseFile,
        nativeTurnId,
        corruption,
        executionId,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      expect(
        corrupted.providerAttempts.find(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        )?.outcome,
      ).toBe("InProgress");
      expect(
        corrupted.providerTurns.find(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toEqual(beforeTurn);

      const restartResult = await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_REPORT_URL: reportUrl,
          },
        })
        .then(
          () => ({ healthy: true as const }),
          (error: unknown) => ({ healthy: false as const, error }),
        );
      let rejected: Ah19Snapshot;
      if (restartResult.healthy) {
        rejected = await waitForPublic(
          async () => readSnapshot(fixture.databaseFile, ids),
          (snapshot) =>
            snapshot.providerAttempts.some(
              (attempt) =>
                attempt.provider_turn_id === nativeTurnId &&
                attempt.outcome === "TerminalFailure",
            ),
          60_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH19 malformed Native prefix was not failed closed (${corruption}): ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${scenario.childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
      } else {
        const childFailure = scenario.childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                error?: {
                  cause?: { safeDiagnostic?: string };
                };
              };
            } catch {
              return undefined;
            }
          })
          .find((event) => event?.tag === "AH19_CHILD_ERROR");
        expect(childFailure?.error?.cause?.safeDiagnostic).toBe(
          "provider-turn-recovery-stopped",
        );
        rejected = readSnapshot(fixture.databaseFile, ids);
      }
      const rejectedTurn = rejected.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(rejectedTurn).toMatchObject({
        output_contract_ref: "provider-native-compaction-v1",
        finish_reason: "Failed",
      });
      expect(rejected.session?.context_epoch).toBe(0);
      expect(rejected.checkpoints).toEqual([]);
      expect(
        rejected.providerTurns.filter(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toHaveLength(1);
      expect(
        providerRequests.filter(
          (event) => event.operationKind === "CompactionNative",
        ),
      ).toEqual([
        expect.objectContaining({
          providerTurnId: nativeTurnId,
          bindingVariant: "A",
        }),
      ]);
    },
    180_000,
  );

  it("locally commits the same settled Native receipt after a pre-checkpoint crash when the binding still matches", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toMatchObject({ settled_at: expect.any(String), finish_reason: "Stop" });
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session).toEqual(beforeKill.session);
    expect(afterKill.checkpoints).toEqual([]);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });

    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    );
    expect(recovered.checkpoints).toHaveLength(1);
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.some(
        (event) =>
          event.bindingVariant === "A" &&
          event.operationKind === "Inference" &&
          event.items.some(
            (item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`,
          ),
      ),
    ).toBe(true);
    expect(
      providerRequests.some(
        (event) => event.operationKind === "CompactionSummary",
      ),
    ).toBe(false);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);

  it("fails closed when a Native manifest claims a different source logical step", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.providerTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider_turn_id: nativeTurnId }),
      ]),
    );
    const beforeKillNativeManifest = JSON.parse(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      )?.manifest_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeKillNativeManifest.logicalStepNo).toBe(1);
    expect(
      beforeKill.providerLinks.filter(
        (link) => link.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        logical_step_no: 1,
        repair_attempt: 0,
        overflow_ordinal: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_1`,
        context_epoch: 0,
      }),
    ]);

    await fixture.crash();
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptNativeManifestLogicalStepNo(fixture.databaseFile, nativeTurnId, 0);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    const corruptedNative = corrupted.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(
      JSON.parse(corruptedNative?.manifest_json ?? "{}").logicalStepNo,
    ).toBe(0);
    expect(nativeTurnId).toContain("_1_native_compact_0");

    const restartFailure = await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(restartFailure).not.toBeNull();
    const childFailure = scenario.childOutput
      .map((line) => {
        try {
          return JSON.parse(line) as {
            tag?: string;
            error?: { reason?: string };
          };
        } catch {
          return undefined;
        }
      })
      .find((event) => event?.tag === "AH19_CHILD_ERROR");
    expect(childFailure?.error?.reason).toBe(
      "AgentLoopStepReplayBindingMismatch",
    );
    const rejected = readSnapshot(fixture.databaseFile, ids);
    expect(rejected.session?.context_epoch).toBe(1);
    expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
    expect(rejected.execution?.settled_at).toBeNull();
    expect(rejected.leases.at(-1)?.generation).toBe(1);
    expect(rejected.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_step_no: 1,
          repair_attempt: 0,
          provider_turn_id: nativeTurnId.replace("_native_compact_0", ""),
          state: "Prepared",
        }),
      ]),
    );
    expect(
      rejected.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(
      rejected.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([expect.objectContaining({ attempt_no: 0, outcome: "Success" })]);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
  }, 150_000);

  it.each(["repairAttempt", "role", "predecessor"] as const)(
    "fails closed when the P20 source link has a mismatched %s",
    async (corruption) => {
      const scenario = await startAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const { fixture, project, workId, probe, reportUrl } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(
        beforeKill.providerLinks.find(
          (link) => link.provider_turn_id === nativeTurnId,
        ),
      ).toMatchObject({
        logical_step_no: 1,
        repair_attempt: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_1`,
        context_epoch: 0,
      });

      await fixture.crash();
      await waitForLeaseExpiry(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptNativeSourceLink(
        fixture.databaseFile,
        nativeTurnId,
        corruption,
        executionId,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      const corruptedLink = corrupted.providerLinks.find(
        (link) => link.provider_turn_id === nativeTurnId,
      );
      expect(corruptedLink).toBeDefined();
      if (corruption === "repairAttempt") {
        expect(corruptedLink?.repair_attempt).toBe(1);
      } else if (corruption === "role") {
        expect(corruptedLink?.role).toBe("OverflowReplacement");
      } else {
        expect(corruptedLink?.predecessor_provider_turn_id).toBe(
          `ptn_${executionId}_0`,
        );
      }

      const restartFailure = await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "B",
            ARBOR_AH19_REPORT_URL: reportUrl,
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(restartFailure).not.toBeNull();
      const childFailure = scenario.childOutput
        .map((line) => {
          try {
            return JSON.parse(line) as {
              tag?: string;
              error?: { reason?: string };
            };
          } catch {
            return undefined;
          }
        })
        .find((event) => event?.tag === "AH19_CHILD_ERROR");
      expect(childFailure?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );
      const rejected = readSnapshot(fixture.databaseFile, ids);
      expect(rejected.session?.context_epoch).toBe(1);
      expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
      expect(rejected.execution?.settled_at).toBeNull();
      expect(rejected.leases.at(-1)?.generation).toBe(1);
      expect(
        rejected.steps.find((step) => step.logical_step_no === 1),
      ).toMatchObject({ repair_attempt: 0, state: "Prepared" });
      expect(
        providerRequests.filter((event) => event.bindingVariant === "B"),
      ).toEqual([]);
    },
    150_000,
  );

  it("rebuilds through portable Summary after a committed Native checkpoint's binding changes", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const nativeCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(nativeCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "ProviderNative",
      opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
    });
    const oldBindingFingerprint = nativeCheckpoint.bindingFingerprint;
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session).toEqual(beforeKill.session);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    await waitForLeaseExpiry(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .catch((error: unknown) => {
        throw new Error(
          `AH19 gen1 daemon failed startup: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}`,
        );
      });

    await waitForPublic(
      async () =>
        providerRequests.some(
          (event) =>
            event.bindingVariant === "B" &&
            event.operationKind === "CompactionSummary",
        ),
      (seen) => seen,
      20_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 mismatch never requested portable Summary: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 2 &&
        snapshot.checkpoints.length === 2 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 portable rebase did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });

    const summaryCheckpoint = JSON.parse(
      recovered.checkpoints[1]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(summaryCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "Summary",
      fromEpoch: 1,
      toEpoch: 2,
      bindingFingerprint: null,
    });
    expect(summaryCheckpoint.summaryText).toContain(
      "Portable AH19 continuation B.",
    );
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    const mismatchedRequests = providerRequests.filter(
      (event) => event.bindingVariant === "B",
    );
    expect(mismatchedRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      mismatchedRequests
        .flatMap((event) => event.items)
        .some((item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`),
    ).toBe(false);
    expect(
      providerRequests.some(
        (event) =>
          event.operationKind === "CompactionSummary" &&
          event.bindingVariant === "B" &&
          event.items.some((item) => item._tag === "ControlResult"),
      ),
    ).toBe(true);
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(oldBindingFingerprint).toMatch(/^p16fp_[0-9a-f]{64}$/u);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
});
