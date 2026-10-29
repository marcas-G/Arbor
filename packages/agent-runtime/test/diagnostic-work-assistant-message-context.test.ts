import {
  ContextEpochNumber,
  ExecutionId,
  parse,
  providerTurnInferenceId,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  compileTurn,
  type ModelContextPlan,
  projectSessionTimeline,
} from "@arbor/model-context";
import {
  type AgentLoopStepRecord,
  portableInputItems,
  type SessionEntryRecord,
  sha256Hex,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MAX_TURNS } from "../src/agent-loop-policy.js";
import { completeAgentLoopStep } from "../src/agent-loop-step-completion.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000091",
);
const sessionId = parse(SessionId)("ses_00000000-0000-7000-8000-000000000091");
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000091",
);
const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000091");
const execution = {
  executionId,
  sessionId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    episode: {
      _tag: "WorkEpisode",
      workId,
      targetWorkRevision: 0,
    },
  },
} as never;

const sessionEntry = (
  sequence: number,
  entryKind: SessionEntryRecord["entryKind"],
  payload: unknown,
  sourceKind: string,
  sourceRef: string,
): SessionEntryRecord => ({
  sessionId,
  sequence,
  entryKind,
  payload,
  createdAt: `2026-10-24T00:00:0${sequence}.000Z`,
  source: {
    kind: sourceKind,
    ref: sourceRef,
    contentHash: `hash:${sourceRef}`,
  },
});

const initialInput = sessionEntry(
  1,
  "Input",
  {
    _tag: "UserMessage",
    source: { _tag: "InboxEntry", kind: "Message" },
    text: "Inspect the workspace and make useful progress.",
  },
  "Runtime",
  "input:work-bootstrap",
);

const persistedPlainAssistantOutput = (text: string): SessionEntryRecord => ({
  ...sessionEntry(
    2,
    "ModelOutput",
    {
      _tag: "AssistantMessage",
      providerTurnId: providerTurnInferenceId(executionId, 0),
      contentRef: `provider:${providerTurnInferenceId(executionId, 0)}:assistant`,
      text,
      finishReason: "Stop",
    },
    "ProviderTurn",
    `${providerTurnInferenceId(executionId, 0)}:assistant`,
  ),
  source: {
    kind: "ProviderTurn",
    ref: `${providerTurnInferenceId(executionId, 0)}:assistant`,
    contentHash: sha256Hex(JSON.stringify({ text, finishReason: "Stop" })),
  },
});

const persistedToolCall = (
  sequence: number,
  callRef: string,
  toolRef: string,
): SessionEntryRecord =>
  sessionEntry(
    sequence,
    "ModelOutput",
    {
      _tag: "ToolCall",
      callRef,
      toolRef,
      argumentsJson: "{}",
    },
    "ProviderTurn",
    `${providerTurnInferenceId(executionId, sequence - 1)}:${callRef}`,
  );

const persistedControlResult = (
  sequence: number,
  callRef: string,
): SessionEntryRecord =>
  sessionEntry(
    sequence,
    "Observation",
    {
      _tag: "ControlResult",
      callRef,
      actionKind: "wait",
      status: "Succeeded",
      outputText: "wait completed",
      observationRef: `observation:${callRef}`,
      canonicalRefs: [],
    },
    "ControlAction",
    callRef,
  );

const persistedToolResult = (
  sequence: number,
  callRef: string,
): SessionEntryRecord =>
  sessionEntry(
    sequence,
    "Observation",
    {
      _tag: "ToolResult",
      callRef,
      toolName: "read",
      status: "Succeeded",
      outputText: "file contents",
      observationRef: `observation:${callRef}`,
      artifactRefs: [],
      truncated: false,
    },
    "ToolInvocation",
    callRef,
  );

const projectedInputFingerprint = (
  entries: ReadonlyArray<SessionEntryRecord>,
): string =>
  sha256Hex(JSON.stringify(projectSessionTimeline(entries).inputItems));

const compileProjectedRequest = (
  entries: ReadonlyArray<SessionEntryRecord>,
  step: number,
) => {
  const projection = projectSessionTimeline(entries);
  const plan: ModelContextPlan = {
    instructions: {
      effective: [],
      suppressed: [],
      conflicts: [],
      governanceIssues: [],
    },
    context: [],
    tools: [],
    skills: [],
    outputContract: "agent-directive-v1",
    continuation: "recent-frontier",
    controlBasis: {
      projectPolicyRevision: 0,
      workspacePolicyRevision: 0,
      responsibilityRevision: 0,
      resourceBoundaryRevision: 0,
      authorizationDigest: "diagnostic-authorization",
      environmentRevision: "diagnostic-environment",
    },
    inputItems: projection.inputItems,
    messageContextRefs: projection.contextRefs,
  };

  return compileTurn({
    plan,
    capability: {
      modelRef: "model-diagnostic",
      family: "family-diagnostic",
      contextWindow: 4096,
      outputCeiling: 512,
      toolProtocol: "json",
    },
    providerTurnId: providerTurnInferenceId(executionId, step),
    executionId,
    sessionId,
    contextEpoch: parse(ContextEpochNumber)(0),
    maxOutputTokens: 512,
    stepContext: {
      logicalStepNo: step,
      repairAttempt: 0,
      inputFrontier: projection.frontier,
      fingerprint: `diagnostic-step-${step}`,
      bindingFingerprint: "diagnostic-binding",
    },
  });
};

const loopStep = (turn: number): AgentLoopStepRecord => ({
  identity: { executionId, logicalStepNo: turn, repairAttempt: 0 },
  providerTurnId: providerTurnInferenceId(executionId, turn),
  state: "ActionsInProgress",
  nextActionIndex: 0,
  revision: 4,
  updatedAt: "2026-10-24T00:00:00.000Z",
});

const runPlainStopWorkStep = async (turn: number) => {
  const transitions: AgentLoopStepRecord[] = [];
  const successors: AgentLoopStepRecord[] = [];
  const loopSteps = {
    transition: (input: { readonly next: AgentLoopStepRecord }) => {
      transitions.push(input.next);
      return Effect.succeed(input.next);
    },
    ensureSuccessor: (
      _predecessor: unknown,
      successor: AgentLoopStepRecord,
    ) => {
      successors.push(successor);
      return Effect.succeed(successor);
    },
  } as never;
  const tx = {
    transact: (body: Effect.Effect<unknown, unknown, never>) => body,
  } as never;

  const result = await Effect.runPromise(
    completeAgentLoopStep({
      input: {
        execution,
        context: { _tag: "Diagnostic" } as never,
      },
      decodedOutput: {
        text: "I have finished.",
        finishReason: "Stop",
        toolInvocations: [],
      } as never,
      observations: [],
      conversation: false,
      turn,
      currentLoopStep: loopStep(turn),
      loopSteps,
      loopStepFence: {
        executionId,
        workerId: "diagnostic-worker",
        workerIncarnationId: "diagnostic-incarnation",
        fencingGeneration: 1,
      } as never,
      tx,
      sessions: {} as never,
      failure: (cause) => cause as never,
      now: () => Effect.succeed("2026-10-24T00:00:02.000Z"),
    }),
  );

  return { result, transitions, successors };
};

describe("S4-CONTEXT-DG-01: WorkspaceWork text-only Stop continuity", () => {
  it("projects the accepted output into the next provider request, then advances the same Execution", async () => {
    const outputText = "I have finished.";
    const beforeOutput = projectSessionTimeline([initialInput]);
    const afterPersistedOutput = projectSessionTimeline([
      initialInput,
      persistedPlainAssistantOutput(outputText),
    ]);

    expect(afterPersistedOutput.frontier).toEqual({
      firstSequence: 1,
      lastSequence: 2,
    });
    expect(afterPersistedOutput.inputItems).toEqual([
      ...beforeOutput.inputItems,
      {
        _tag: "Message",
        role: "assistant",
        text: outputText,
      },
    ]);
    expect(afterPersistedOutput.contextRefs).toEqual([
      ...beforeOutput.contextRefs,
      `session:ProviderTurn:${providerTurnInferenceId(executionId, 0)}:assistant`,
    ]);
    expect(
      projectedInputFingerprint([
        initialInput,
        persistedPlainAssistantOutput(outputText),
      ]),
    ).not.toBe(projectedInputFingerprint([initialInput]));
    const beforeRequest = compileProjectedRequest([initialInput], 0);
    const nextRequest = compileProjectedRequest(
      [initialInput, persistedPlainAssistantOutput(outputText)],
      1,
    );
    expect(portableInputItems(nextRequest.request)).toContainEqual({
      _tag: "Message",
      role: "assistant",
      text: outputText,
    });
    expect(portableInputItems(nextRequest.request)).not.toEqual(
      portableInputItems(beforeRequest.request),
    );
    expect(nextRequest.manifest.compiledRequestHash).not.toBe(
      beforeRequest.manifest.compiledRequestHash,
    );
    expect(nextRequest.manifest.inputFrontier).toEqual({
      firstSequence: 1,
      lastSequence: 2,
    });
    expect(nextRequest.manifest.providerTurnId).not.toBe(
      beforeRequest.manifest.providerTurnId,
    );

    const continuation = await runPlainStopWorkStep(0);
    expect(continuation.result).toEqual({ _tag: "Continue" });
    expect(continuation.transitions.map((step) => step.state)).toEqual([
      "StepEffectsCommitted",
      "NextStepReady",
    ]);
    expect(continuation.successors).toMatchObject([
      {
        identity: { executionId, logicalStepNo: 1, repairAttempt: 0 },
        predecessor: { executionId, logicalStepNo: 0, repairAttempt: 0 },
        providerTurnId: providerTurnInferenceId(executionId, 1),
        state: "Prepared",
      },
    ]);
  });

  it("changes projected input when a later tool or control action has a result", () => {
    const assistantOnly = [
      initialInput,
      persistedPlainAssistantOutput("I have finished."),
    ];
    const controlCallRef = "call_control_diagnostic";
    const controlEntries = [
      ...assistantOnly,
      persistedToolCall(3, controlCallRef, "wait"),
      persistedControlResult(4, controlCallRef),
    ];
    const toolCallRef = "call_tool_diagnostic";
    const toolEntries = [
      ...assistantOnly,
      persistedToolCall(3, toolCallRef, "read"),
      persistedToolResult(4, toolCallRef),
    ];

    const assistantProjection = projectSessionTimeline(assistantOnly);
    const controlProjection = projectSessionTimeline(controlEntries);
    const toolProjection = projectSessionTimeline(toolEntries);
    const assistantRequest = compileProjectedRequest(assistantOnly, 0);
    const controlRequest = compileProjectedRequest(controlEntries, 1);
    const toolRequest = compileProjectedRequest(toolEntries, 2);

    expect(controlProjection.inputItems).not.toEqual(
      assistantProjection.inputItems,
    );
    expect(toolProjection.inputItems).not.toEqual(
      assistantProjection.inputItems,
    );
    expect(controlProjection.inputItems).toContainEqual({
      _tag: "ControlResult",
      callRef: controlCallRef,
      actionKind: "wait",
      status: "Succeeded",
      outputText: "wait completed",
      observationRef: `observation:${controlCallRef}`,
      canonicalRefs: [],
    });
    expect(toolProjection.inputItems).toContainEqual({
      _tag: "ToolResult",
      callRef: toolCallRef,
      toolName: "read",
      status: "Succeeded",
      outputText: "file contents",
      observationRef: `observation:${toolCallRef}`,
      artifactRefs: [],
      truncated: false,
    });
    expect(projectedInputFingerprint(controlEntries)).not.toBe(
      projectedInputFingerprint(assistantOnly),
    );
    expect(projectedInputFingerprint(toolEntries)).not.toBe(
      projectedInputFingerprint(assistantOnly),
    );
    expect(portableInputItems(controlRequest.request)).not.toEqual(
      portableInputItems(assistantRequest.request),
    );
    expect(portableInputItems(toolRequest.request)).not.toEqual(
      portableInputItems(assistantRequest.request),
    );
    expect(controlRequest.manifest.compiledRequestHash).not.toBe(
      assistantRequest.manifest.compiledRequestHash,
    );
    expect(toolRequest.manifest.compiledRequestHash).not.toBe(
      assistantRequest.manifest.compiledRequestHash,
    );
  });

  it("documents that the no-action path is finite, but ends at the hard turn limit", async () => {
    expect(MAX_TURNS).toBe(24);
    const finalTurn = await runPlainStopWorkStep(MAX_TURNS - 1);
    expect(finalTurn.result).toEqual({ _tag: "Continue" });
    expect(finalTurn.transitions.map((step) => step.state)).toEqual([
      "StepEffectsCommitted",
    ]);
    expect(finalTurn.successors).toEqual([]);
  });
});
