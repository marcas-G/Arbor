import {
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  providerTurnInferenceId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type ClockService,
  type ExecutableApprovalRecord,
  type ExecutableApprovalRequest,
  type ExecutableApprovalStoreService,
  sha256Hex,
  type ToolRuntimePortService,
  type TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { shellPolicy } from "@arbor/tool-runtime";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutableToolHandler } from "../src/executable-tool-handler.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:p38-shell-policy");
const now = "2026-10-12T00:00:00.000Z";
const episode = {
  _tag: "WorkEpisode" as const,
  workId: "wrk_p38_shell_approval",
  targetWorkRevision: 1,
};
const currentSandboxPolicyResolution = {
  policy: {
    kind: "TrustedLocalUnconfinedRuntimePolicy" as const,
    executionId,
    episodeBinding: episode,
    sandboxHandleId: "sbx_p38_shell_approval",
    policyRevision: 1,
    profile: "FullAccess" as const,
    providerId: "TrustedLocal" as const,
    providerVersion: "builtin-v1",
    capabilityRevision: "builtin-v1",
    boundary: "TrustedLocal" as const,
    trustedRuntimeIdentity: "TrustedLocal" as const,
    trustedRuntimeVersion: "builtin-v1",
    networkBoundary: "Unconfined" as const,
    policyDigest: "b".repeat(64),
    admittedMounts: [
      {
        ref: "workspace",
        rootPath: "C:/arbor/p38-shell-approval",
        access: "ReadWrite" as const,
      },
    ],
    environmentAllowlist: ["PATH"],
    limits: {
      wallTimeMs: 5_000,
      stdoutBytes: 1_024,
      stderrBytes: 1_024,
      processCount: 1,
      memoryBytes: 1_000_000,
      cpuTimeMs: 5_000,
    },
    auditRefs: ["cmd_p38_shell_approval"],
  },
  mounts: [
    {
      ref: "workspace",
      address: {
        _tag: "FileTree" as const,
        path: "C:/arbor/p38-shell-approval",
      },
      region: {
        resourceSpaceId: "filesystem",
        normalizedRegion: {
          kind: "FileTree",
          path: "C:/arbor/p38-shell-approval",
        },
      },
      access: "ReadWrite" as const,
    },
  ],
};

const runApprovalHandoff = async (command: string) => {
  const pending: ExecutableApprovalRecord[] = [];
  let toolCalls = 0;
  const controlBasis = { episode: "p38-shell-policy-test" };
  const controlBasisDigest = sha256Hex(JSON.stringify(controlBasis));
  const authority = {
    principal,
    workspaceId,
    executionId,
    toolName: "shell",
    toolVersion: "2",
    resourceSpaceIds: [],
    allowedCapabilities: ["shell:exec"],
    controlBasisDigest,
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  };
  const tools: ToolRuntimePortService = {
    invoke: (intent, context) =>
      Effect.gen(function* () {
        toolCalls += 1;
        if (context.resolveSandboxProcessPolicy === undefined) {
          return yield* Effect.die(
            "fixture must provide the current shell sandbox policy",
          );
        }
        const resolved = yield* context.resolveSandboxProcessPolicy({ now });
        if (
          resolved?.policy.kind !== "TrustedLocalUnconfinedRuntimePolicy" ||
          resolved.mounts[0]?.ref !== "workspace"
        ) {
          return yield* Effect.die(
            "fixture must resolve the TrustedLocal policy with its P11 mount",
          );
        }
        const selected = JSON.parse(intent.argumentsJson) as {
          command: string;
        };
        if (shellPolicy(selected.command) === "RequireApproval") {
          return {
            _tag: "ApprovalRequired" as const,
            authority: {
              ...authority,
              controlBasisDigest: context.controlBasisDigest,
            },
            targetResourceSpaceIds: [],
            actionDigest: `action:${selected.command}`,
            requestedCapabilities: ["shell:exec"],
            sideEffectSemantics: "Reconcilable" as const,
            controlBasisDigest: context.controlBasisDigest,
          };
        }
        return {
          _tag: "Success" as const,
          observation: { text: "safe command", truncated: false },
          resultRef: null,
        };
      }),
  };
  const catalog = {
    visibleRefs: () =>
      Effect.succeed([{ name: "shell", version: "2", hash: "shell-v2" }]),
    resolveForModel: () => Effect.die("unused"),
  };
  const store: ExecutableApprovalStoreService = {
    findByActionKey: () =>
      Effect.succeed(
        pending[0] === undefined ? Option.none() : Option.some(pending[0]),
      ),
    putPendingExact: (request: ExecutableApprovalRequest) => {
      const record: ExecutableApprovalRecord = {
        ...request,
        routeKind: "Executable",
        revision: 0,
        state: "Pending",
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
        cancelledAt: null,
        cancelledBy: null,
        cancellationReason: null,
        consumedAt: null,
        consumedBy: null,
      };
      pending.push(record);
      return Effect.succeed(record);
    },
  } as never;
  const transaction: TransactionPortService = {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.provideService(body, TransactionScope, {
        session: { id: "p38-shell-approval-handoff" },
      }),
  };
  const clock: ClockService = { now: () => Effect.succeed(now) };
  const handler = makeExecutableToolHandler(
    tools,
    clock,
    catalog,
    undefined,
    {
      store,
      transaction,
      resolveCandidate: () =>
        Effect.succeed({
          approvalId: "eap_018f2b3c-4d5e-7abc-8def-0123456789a1",
          expiresAt: "2999-01-01T00:00:00.000Z",
        }),
    },
    undefined,
    () => Effect.succeed(currentSandboxPolicyResolution as never),
  );
  const fence = {
    executionId,
    workerId: "worker:p38-shell-policy",
    workerIncarnationId: "incarnation:p38-shell-policy",
    fencingGeneration: 0 as never,
  };
  const outcome = await Effect.runPromise(
    handler.handle({
      invocation: {
        providerTurnId: providerTurnInferenceId(
          parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
          0,
        ),
        outputPosition: 0,
        callRef: "p38-shell-call",
        toolName: "shell",
        argumentsJson: JSON.stringify({
          command,
          cwd: { mount: "workspace", path: "." },
        }),
      },
      execution: {
        executionId,
        projectId,
        workspaceId,
        sessionId,
        binding: { _tag: "WorkspaceExecution", workspaceId, episode },
        admittedAt: now,
        stopRequestedAt: null,
        state: { status: "Active", settlement: null },
      } as never,
      context: {
        _tag: "ExecutionOrigin",
        principal,
        executionId,
        workerId: fence.workerId,
        workerIncarnationId: fence.workerIncarnationId,
        fencingGeneration: fence.fencingGeneration,
      },
      controlBasis: controlBasis as never,
      action: {
        logicalStepNo: 0,
        repairAttempt: 0,
        actionIndex: 0,
        logicalActionId: "logical-action-p38-shell",
      },
      executionFence: fence,
    }),
  );
  return { outcome, pending, toolCalls };
};

describe("P38 shell policy approval handoff", () => {
  it.each(["python -c 'print(1)'", "ls -la; rm file.txt"])(
    "persists an exact Pending approval for %s without invoking a shell effect",
    async (command) => {
      const result = await runApprovalHandoff(command);
      expect(result.outcome).toMatchObject({
        _tag: "ApprovalRequired",
        revision: 0,
        approvalId: "eap_018f2b3c-4d5e-7abc-8def-0123456789a1",
      });
      expect(result.toolCalls).toBe(1);
      expect(result.pending).toHaveLength(1);
      expect(result.pending[0]).toMatchObject({
        routeKind: "Executable",
        state: "Pending",
        revision: 0,
        executionId,
        workspaceId,
        toolName: "shell",
        callRef: "p38-shell-call",
        argumentsJson: expect.stringContaining(command),
        logicalActionId: "logical-action-p38-shell",
      });
    },
  );
});
