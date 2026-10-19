import {
  CommandId,
  decodeCanonicalSandboxNetworkPolicySelectionV1,
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  ExecutionId,
  encodeEffectivePolicySummaryV1,
  encodeExecutionEpisodeBinding,
  encodeSandboxNetworkPolicySelectionV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  PermissionGrantId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
  workspaceEpisodeExecution,
} from "@arbor/domain";
import {
  SandboxPolicyDecisionStore,
  SandboxProviderUnavailableStore,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  executeAgentLoopActions,
  verifySandboxUnavailableStepActionResume,
} from "../src/agent-loop-actions.js";
import { completeAgentLoopStep } from "../src/agent-loop-step-completion.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000081",
);
const projectId = parse(ProjectId)("prj_00000000-0000-7000-8000-000000000081");
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000081",
);
const sessionId = parse(SessionId)("ses_00000000-0000-7000-8000-000000000081");
const episode = {
  _tag: "WorkEpisode" as const,
  workId: "wrk_00000000-0000-7000-8000-000000000081" as never,
  targetWorkRevision: 4 as never,
};
const execution = {
  executionId,
  projectId,
  workspaceId,
  sessionId,
  binding: workspaceEpisodeExecution(workspaceId, episode),
} as never;
const oldPolicyDigest = "a".repeat(64);
const actionIdentity = { executionId, logicalStepNo: 0, repairAttempt: 0 };
const step = {
  identity: actionIdentity,
  providerTurnId: "ptn_00000000-0000-7000-8000-000000000081" as never,
  manifestId: "manifest_old-policy",
  state: "StepEffectsCommitted" as const,
  decodedOutputHash: "b".repeat(64),
  decoderVersion: "decode-turn-v1" as const,
  modelOutputSessionSequence: 2,
  nextActionIndex: 2,
  revision: 3,
  updatedAt: "2026-10-18T10:00:00.000Z",
};
const disposition = {
  _tag: "SandboxUnavailableV1" as const,
  attentionFactId: "sbf_00000000-0000-7000-8000-000000000081",
  invocationId: "tin_00000000-0000-7000-8000-000000000081",
  policyRevision: 7,
  policyDigest: oldPolicyDigest,
  profile: "WorkspaceWrite" as const,
  providerId: "native-test-provider",
  providerVersion: "1.0.0",
  capabilityRevision: "cap-7",
  probeEvidenceRef: "probe-evidence-7",
  failureCode: "ProviderUnavailable",
};
const action = {
  identity: actionIdentity,
  actionIndex: 1,
  logicalActionId: "lac_old-policy-action",
  callRef: "call_old-policy",
  routeKind: "Executable" as const,
  actionKind: "write_file",
  inputHash: "c".repeat(64),
  state: "TerminalRejected" as const,
  resultRef: disposition.attentionFactId,
  disposition,
  revision: 2,
  updatedAt: "2026-10-18T10:00:00.000Z",
};
const fact = {
  attentionFactId: disposition.attentionFactId,
  eventId: "evt_00000000-0000-7000-8000-000000000081",
  projectId,
  executionId,
  workspaceId,
  episodeBinding: episode,
  policyRevision: disposition.policyRevision,
  policyDigest: oldPolicyDigest,
  profileId: disposition.profile,
  providerId: disposition.providerId,
  providerVersion: disposition.providerVersion,
  probeEvidenceRef: disposition.probeEvidenceRef,
  failureCode: disposition.failureCode,
  firstDetectedAt: "2026-10-18T09:59:00.000Z",
};
const decision = {
  projectId,
  workspaceId,
  executionId,
  episodeBinding: episode,
  policyRevision: 8,
  expectedExecutionRevision: 1,
  expectedPolicyRevision: 7,
  profile: "WorkspaceWrite",
  providerId: "native-test-provider",
  policyDigest: "d".repeat(64),
  expiresAt: "2026-10-19T00:00:00.000Z",
};
const result = {
  version: 1,
  commandId: "cmd_00000000-0000-7000-8000-000000000081",
  projectId,
  workspaceId,
  executionId,
  episodeBinding: episode,
  policyRevision: 8,
  policyDigest: decision.policyDigest,
  effectivePolicySnapshot: {
    kind: "OsEnforced",
    policyRevision: 8,
    profile: "WorkspaceWrite",
    providerId: "native-test-provider",
    projectId,
    workspaceId,
    executionId,
    episodeBinding: episode,
    capabilityRevision: 8,
    expiresAt: decision.expiresAt,
  },
};
const decodedOutput = {
  text: "continuing after policy revision 8",
  finishReason: "ToolCalls",
  toolInvocations: [
    {
      providerTurnId: step.providerTurnId,
      outputPosition: 0,
      callRef: "call_prior-applied",
      toolName: "write_file",
      argumentsJson: '{"path":"prior.txt"}',
    },
    {
      providerTurnId: step.providerTurnId,
      outputPosition: 1,
      callRef: "call_old-policy",
      toolName: "read_file",
      argumentsJson: '{"path":"old.txt"}',
    },
    {
      providerTurnId: step.providerTurnId,
      outputPosition: 2,
      callRef: "call_not-yet-admitted",
      toolName: "read_file",
      argumentsJson: '{"path":"next.txt"}',
    },
  ],
};
const toolRoutes = [
  { name: "write_file", route: "Executable" as const },
  { name: "read_file", route: "Executable" as const },
];
const modelRef = "model-p9-test";
const outputContractRef = "plain-text-v1";
const manifestJson = JSON.stringify({
  providerTurnId: step.providerTurnId,
  executionId,
  sessionId,
  contextEpoch: 0,
  modelRef,
  outputContractRef,
  logicalStepNo: 0,
  repairAttempt: 0,
  toolRoutes,
});
const persistedStep = {
  ...step,
  decodedOutputHash: sha256Hex(
    JSON.stringify({
      providerTurnId: step.providerTurnId,
      outputContractRef,
      decoderVersion: "decode-turn-v1",
      ...decodedOutput,
    }),
  ),
};
const terminalAction = {
  ...action,
  callRef: decodedOutput.toolInvocations[1]?.callRef,
  actionKind: "read_file",
  logicalActionId: `lac_${sha256Hex(
    JSON.stringify({
      executionId,
      providerTurnId: step.providerTurnId,
      callRef: decodedOutput.toolInvocations[1]?.callRef,
      routeKind: "Executable",
      actionKind: "read_file",
    }),
  )}`,
  inputHash: sha256Hex(decodedOutput.toolInvocations[1]?.argumentsJson ?? ""),
};
const priorAppliedAction = {
  identity: actionIdentity,
  actionIndex: 0,
  logicalActionId: `lac_${sha256Hex(
    JSON.stringify({
      executionId,
      providerTurnId: step.providerTurnId,
      callRef: decodedOutput.toolInvocations[0]?.callRef,
      routeKind: "Executable",
      actionKind: "write_file",
    }),
  )}`,
  callRef: decodedOutput.toolInvocations[0]?.callRef,
  routeKind: "Executable" as const,
  actionKind: "write_file",
  inputHash: sha256Hex(decodedOutput.toolInvocations[0]?.argumentsJson ?? ""),
  state: "Applied" as const,
  resultRef: "artifact_prior-applied",
  observationSourceRef: "obs_prior-applied",
  revision: 1,
  updatedAt: "2026-10-18T09:58:00.000Z",
};

const trustedLocalCommittedFixture = () => {
  const decisionCommandId = parse(CommandId)(
    "cmd_00000000-0000-7000-8000-000000000082",
  );
  const policyNetworkSelection = {
    kind: "TrustedLocalUnconfinedV1" as const,
    version: 1 as const,
  };
  const canonicalNetworkSelection = encodeSandboxNetworkPolicySelectionV1(
    policyNetworkSelection,
  );
  const trustedSummary = {
    version: 1 as const,
    kind: "TrustedLocalUnconfinedV1" as const,
    projectId,
    workspaceId,
    executionId,
    episodeBinding: episode,
    workspaceRevision: 5,
    resourceBoundaryRevision: 2,
    resourceBoundaryDigest: "1".repeat(64),
    sandboxEnvironmentBasisDigest: "2".repeat(64),
    policyRevision: 8,
    expiresAt: "2026-10-19T00:00:00.000Z",
    trustedRuntimeIdentity: "TrustedLocal" as const,
    trustedRuntimeVersion: "builtin-v1" as const,
    profile: "FullAccess" as const,
    networkBoundary: "Unconfined" as const,
    sandboxHandleBindingDigest: "3".repeat(64),
    mounts: [
      {
        mountId: "workspace",
        targetRef: "workspace",
        targetIdentityDigest: "4".repeat(64),
        access: "ReadWrite" as const,
      },
    ],
    environmentAllowlist: ["PATH"],
    limits: {
      wallTimeMs: 1000,
      stdoutBytes: 1000,
      stderrBytes: 1000,
      processCount: 2,
      memoryBytes: 1024,
      cpuTimeMs: 1000,
    },
    auditRefs: ["audit:trusted-local"],
    authorityBundleRevision: 3,
    authorityBundleDigest: "5".repeat(64),
    operatorConfigRevision: 4,
    operatorConfigDigest: "6".repeat(64),
  };
  const policyDigest = sha256Hex(
    encodeEffectivePolicySummaryV1(trustedSummary as never),
  );
  const committedResult = {
    version: 1 as const,
    commandId: decisionCommandId,
    projectId,
    workspaceId,
    executionId,
    episodeBinding: episode,
    policyRevision: 8,
    policyDigest,
    effectivePolicySnapshot: trustedSummary,
  };
  const resultJson = encodeSandboxPolicyDecisionCommittedInternalV1(
    committedResult as never,
  );
  const decodedResult = decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
    resultJson,
    sha256Hex,
  );
  const decision = {
    projectId,
    workspaceId,
    executionId,
    episodeBinding: episode,
    policyRevision: 8,
    expectedExecutionRevision: 2,
    expectedPolicyRevision: 7,
    profile: "FullAccess" as const,
    providerId: "TrustedLocal",
    networkPolicy: policyNetworkSelection,
    policyDigest,
    permissionGrantId: parse(PermissionGrantId)(
      "pgr_00000000-0000-7000-8000-000000000082",
    ),
    grantPermissionCommandId: parse(CommandId)(
      "cmd_00000000-0000-7000-8000-000000000083",
    ),
    grantIssuerPrincipal: "user:operator" as never,
    operatorConfigRevision: 4,
    operatorConfigDigest: "6".repeat(64),
    actorPrincipal: "user:subject" as never,
    decisionCommandId,
    issuedAt: "2026-10-18T10:00:00.000Z",
    expiresAt: trustedSummary.expiresAt,
  };
  const commandReceipt = {
    commandId: decisionCommandId,
    projectId,
    schemaVersion: "1",
    resolution: "Committed",
    resultJson,
  };
  const join = (receipt = commandReceipt) => {
    const result = decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
      receipt.resultJson,
      sha256Hex,
    );
    if (
      receipt.commandId !== decision.decisionCommandId ||
      receipt.projectId !== decision.projectId ||
      receipt.schemaVersion !== "1" ||
      receipt.resolution !== "Committed" ||
      result === undefined ||
      result.commandId !== decision.decisionCommandId ||
      result.projectId !== decision.projectId ||
      result.workspaceId !== decision.workspaceId ||
      result.executionId !== decision.executionId ||
      result.policyRevision !== decision.policyRevision ||
      result.policyDigest !== decision.policyDigest ||
      encodeExecutionEpisodeBinding(result.episodeBinding) !==
        encodeExecutionEpisodeBinding(decision.episodeBinding)
    ) {
      return Option.none();
    }
    return Option.some({ decision, result });
  };
  return {
    decision,
    result: decodedResult,
    resultJson,
    commandReceipt,
    join,
    canonicalNetworkSelection,
  };
};

describe("P9 SandboxUnavailableV1 successor recovery", () => {
  it("restarts from the immutable terminal action and advances to one successor under a newer policy", async () => {
    // These rows represent the committed SQLite state after the old process
    // stopped: the P9 fact and terminal action are durable, and the old Step
    // cursor is already past the unavailable action. Recreate the read ports
    // as the new process would; no executable handler is present on recovery.
    const durable = {
      step: persistedStep,
      actions: [
        priorAppliedAction as Record<string, unknown>,
        terminalAction as Record<string, unknown>,
      ],
      fact,
      decision,
      result,
    };
    const facts = {
      findByExecutionAndRevision: () => Effect.succeed(durable.fact),
    };
    const decisions = {
      findCurrentForExecution: () =>
        Effect.succeed(
          Option.some({
            decision: durable.decision,
            result: durable.result,
          }),
        ),
    };
    const sandboxResume = await Effect.runPromise(
      Effect.provideService(
        verifySandboxUnavailableStepActionResume({
          execution,
          step: durable.step as never,
          action: durable.actions[1] as never,
          facts: facts as never,
          decisions: decisions as never,
          now: "2026-10-18T10:01:00.000Z",
        }),
        TransactionScope,
        { session: { id: "p9-sandbox-successor-restart" } },
      ),
    );
    expect(sandboxResume).toBe(true);
    const providerTurns = {
      findSettledResult: () =>
        Effect.succeed({
          _tag: "SettledSuccess",
          evidenceVersion: "provider-success-v1",
          manifestId: durable.step.manifestId,
          manifestJson,
          turn: {
            providerTurnId: durable.step.providerTurnId,
            executionId,
            sessionId,
            contextEpoch: 0,
            modelRef,
            outputContractRef,
          },
          finishReason: decodedOutput.finishReason,
          canonicalEvents: [
            {
              _tag: "TurnStarted",
              providerTurnId: durable.step.providerTurnId,
              attemptNo: 0,
              modelRef,
            },
            { _tag: "TextDelta", text: decodedOutput.text },
            {
              _tag: "ToolCallProposed",
              callRef: "call_prior-applied",
              toolName: "write_file",
              argumentsJson: '{"path":"prior.txt"}',
            },
            {
              _tag: "ToolCallProposed",
              callRef: "call_old-policy",
              toolName: "read_file",
              argumentsJson: '{"path":"old.txt"}',
            },
            {
              _tag: "ToolCallProposed",
              callRef: "call_not-yet-admitted",
              toolName: "read_file",
              argumentsJson: '{"path":"next.txt"}',
            },
            { _tag: "TurnCompleted", finishReason: "ToolCalls" },
          ],
        }),
      findManifestByTurn: () =>
        Effect.succeed({ manifestId: durable.step.manifestId, manifestJson }),
    };
    const sessions = {
      listEntries: () =>
        Effect.succeed([
          {
            entryKind: "ModelOutput",
            sequence: durable.step.modelOutputSessionSequence,
            source: {
              kind: "ProviderTurn",
              ref: `${durable.step.providerTurnId}:assistant`,
            },
            payload: {
              providerTurnId: durable.step.providerTurnId,
              outputContractRef,
              decoderVersion: "decode-turn-v1",
              text: decodedOutput.text,
              finishReason: decodedOutput.finishReason,
              toolInvocations: decodedOutput.toolInvocations,
            },
          },
        ]),
    };
    let executableHandlerCalls = 0;
    const replay = executeAgentLoopActions({
      input: { execution, context: {} as never },
      preparedTurn: {
        manifest: {
          providerTurnId: durable.step.providerTurnId,
          contextEpoch: 0,
          modelRef,
          outputContractRef,
          controlBasis: {},
          toolRoutes,
        },
        toolRoutes,
      } as never,
      decodedOutput: decodedOutput as never,
      turn: 0,
      currentLoopStep: durable.step as never,
      loopSteps: {
        find: () => Effect.succeed(Option.some(durable.step)),
        listActions: () => Effect.succeed(durable.actions),
      } as never,
      loopStepFence: {
        executionId,
        workerId: "worker-restarted",
        workerIncarnationId: "incarnation-restarted",
        fencingGeneration: 1,
      } as never,
      tx: {
        transact: (body: Effect.Effect<unknown, unknown, never>) =>
          Effect.provideService(body, TransactionScope, {
            session: { id: "p9-sandbox-successor-restart" },
          }),
      } as never,
      sessions: sessions as never,
      providerTurns: providerTurns as never,
      controlRegistry: {} as never,
      executableInvocationHandler: {
        handle: () => {
          executableHandlerCalls += 1;
          return Effect.die("committed unavailable action must not replay");
        },
      } as never,
      currentControlBasis: () => Effect.succeed({} as never),
      admit: () => Effect.succeed("Continue"),
      failure: (cause: unknown) => cause as never,
      now: () => Effect.succeed("2026-10-18T10:01:00.000Z"),
    } as never);
    const runReplay = () =>
      Effect.runPromiseExit(
        Effect.provideService(
          Effect.provideService(
            Effect.provideService(
              replay,
              SandboxProviderUnavailableStore,
              facts as never,
            ),
            SandboxPolicyDecisionStore,
            decisions as never,
          ),
          TransactionScope,
          { session: { id: "p9-sandbox-successor-restart" } },
        ),
      );
    const recoveredExit = await runReplay();
    expect(Exit.isSuccess(recoveredExit)).toBe(true);
    if (Exit.isFailure(recoveredExit)) throw new Error("resume failed");
    expect(recoveredExit.value._tag).toBe("Completed");
    expect(executableHandlerCalls).toBe(0);

    durable.actions = [
      { ...priorAppliedAction, state: "Pending" },
      terminalAction,
    ];
    expect(Exit.isFailure(await runReplay())).toBe(true);
    durable.actions = [
      {
        ...priorAppliedAction,
        state: "TerminalRejected",
        disposition: { _tag: "ExecutionSettlement:Failed" },
      },
      terminalAction,
    ];
    expect(Exit.isFailure(await runReplay())).toBe(true);
    durable.actions = [
      priorAppliedAction,
      terminalAction,
      { ...terminalAction, actionIndex: 2 },
    ];
    expect(Exit.isFailure(await runReplay())).toBe(true);
    durable.actions = [priorAppliedAction, terminalAction];

    const transitioned: { predecessor?: unknown; successor?: unknown } = {};
    const loopSteps = {
      transition: (input: { readonly next: unknown }) =>
        Effect.sync(() => {
          transitioned.predecessor = input.next;
          return input.next;
        }),
      ensureSuccessor: (_predecessor: unknown, successor: unknown) =>
        Effect.sync(() => {
          transitioned.successor = successor;
          return successor;
        }),
    };
    const tx = {
      transact: (body: Effect.Effect<unknown, unknown, never>) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "p9-sandbox-successor-restart" },
        }),
    };
    const completion = await Effect.runPromise(
      completeAgentLoopStep({
        input: { execution, context: {} as never },
        decodedOutput: decodedOutput as never,
        observations: [],
        conversation: false,
        turn: 0,
        currentLoopStep: durable.step as never,
        loopSteps: loopSteps as never,
        loopStepFence: {
          executionId,
          workerId: "w",
          workerIncarnationId: "i",
          fencingGeneration: 1,
        } as never,
        tx: tx as never,
        sessions: {} as never,
        failure: (cause) => cause as never,
        now: () => Effect.succeed("2026-10-18T10:01:01.000Z"),
      }),
    );

    expect(completion).toEqual({ _tag: "Continue" });
    expect(transitioned.predecessor).toMatchObject({
      state: "NextStepReady",
      nextActionIndex: 2,
      successor: {
        executionId,
        logicalStepNo: 1,
        repairAttempt: 0,
      },
    });
    expect(transitioned.successor).toMatchObject({
      identity: { executionId, logicalStepNo: 1, repairAttempt: 0 },
      predecessor: actionIdentity,
      state: "Prepared",
    });
    expect(durable.actions).toEqual([priorAppliedAction, terminalAction]);
  });

  it("does not resume on the same policy revision", async () => {
    const sameRevision = {
      ...decision,
      policyRevision: disposition.policyRevision,
    };
    const resultAtSameRevision = {
      ...result,
      policyRevision: disposition.policyRevision,
      effectivePolicySnapshot: {
        ...result.effectivePolicySnapshot,
        policyRevision: disposition.policyRevision,
      },
    };
    const resumed = await Effect.runPromise(
      Effect.provideService(
        verifySandboxUnavailableStepActionResume({
          execution,
          step: step as never,
          action: terminalAction as never,
          facts: {
            findByExecutionAndRevision: () => Effect.succeed(fact),
          } as never,
          decisions: {
            findCurrentForExecution: () =>
              Effect.succeed(
                Option.some({
                  decision: sameRevision,
                  result: resultAtSameRevision,
                }),
              ),
          } as never,
          now: "2026-10-18T10:01:00.000Z",
        }),
        TransactionScope,
        { session: { id: "p9-sandbox-successor-same-revision" } },
      ),
    );
    expect(resumed).toBe(false);
  });

  it("accepts the exact TrustedLocalUnconfinedV1 runtime literals from a joined, current result", async () => {
    const fixture = trustedLocalCommittedFixture();
    expect(
      decodeCanonicalSandboxNetworkPolicySelectionV1(
        fixture.canonicalNetworkSelection,
      ),
    ).toEqual({ kind: "TrustedLocalUnconfinedV1", version: 1 });
    expect(fixture.decision.providerId).toBe("TrustedLocal");
    expect(fixture.decision.networkPolicy).toEqual({
      kind: "TrustedLocalUnconfinedV1",
      version: 1,
    });
    expect(fixture.result).toBeDefined();
    expect(fixture.join()).toEqual(
      Option.some({ decision: fixture.decision, result: fixture.result }),
    );
    expect(
      fixture.join({
        ...fixture.commandReceipt,
        commandId: parse(CommandId)("cmd_00000000-0000-7000-8000-000000000084"),
      }),
    ).toEqual(Option.none());
    const resumed = await Effect.runPromise(
      Effect.provideService(
        verifySandboxUnavailableStepActionResume({
          execution,
          step: step as never,
          action: terminalAction as never,
          facts: {
            findByExecutionAndRevision: () => Effect.succeed(fact),
          } as never,
          decisions: {
            findCurrentForExecution: () => Effect.succeed(fixture.join()),
          } as never,
          now: "2026-10-18T10:01:00.000Z",
        }),
        TransactionScope,
        { session: { id: "p9-sandbox-successor-trusted-local" } },
      ),
    );
    expect(resumed).toBe(true);

    const wrongRuntimeJson = fixture.resultJson.replace(
      '"trustedRuntimeVersion":"builtin-v1"',
      '"trustedRuntimeVersion":"unverified-v1"',
    );
    expect(
      decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
        wrongRuntimeJson,
        sha256Hex,
      ),
    ).toBeUndefined();
  });
});
