import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  type OpenAISdkChunk,
  type OpenAISdkClient,
  OpenAISdkError,
} from "../../adapters/provider-openai/src/index.js";
import { selectProviderLayer } from "../../apps/single-workspace/src/composition.js";
import {
  Actor,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  DEFAULT_MODEL_CATALOG,
  resolveModelCapability,
  resolveModelCatalogEntry,
} from "../../packages/model-context/src/index.js";
import {
  type PortableModelRequest,
  PROVIDER_FAILURE_KINDS,
  type ProviderExecutionContext,
  type ProviderFailure,
  ProviderPort,
  providerFailureDisposition,
} from "../../packages/ports/dist/index.js";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
} from "../../packages/ports/src/index.js";
import {
  BUILTIN_EXECUTORS,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "../../packages/tool-runtime/src/index.js";

// ---------------------------------------------------------------------------
// story 12 (`12`): real provider adapter + catalog + non-minimal tool
// ---------------------------------------------------------------------------

const providerRequest: PortableModelRequest = {
  modelRef: "model-openai",
  instructions: [],
  messages: [],
  toolDefinitions: [],
  outputContractRef: "agent-directive-v1",
  budget: { maxOutputTokens: 128 },
  cacheHints: [],
};
const providerContext: ProviderExecutionContext = {
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  attemptNo: 0,
  cancellationSignal: new AbortController().signal,
  turnDeadlineAt: new Date(Date.now() + 5_000).toISOString(),
};
const sdkClient = (
  chunks: ReadonlyArray<OpenAISdkChunk>,
  error?: OpenAISdkError,
): OpenAISdkClient => ({
  externalEffectPossible: false,
  streamChat: () =>
    (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (error !== undefined) {
        throw error;
      }
    })(),
});

const story12ToolContext = {
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  actor: parse(Actor)("worker:a"),
  authenticatedPrincipal: parse(Principal)("worker:a"),
  executionFence: {
    executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    workerId: "worker:a",
    workerIncarnationId: "incarnation:p12-acceptance-story12",
    fencingGeneration: parse(LeaseGeneration)(0),
  },
  authority: {
    principal: parse(Principal)("worker:a"),
    workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    toolName: "list",
    toolVersion: "2",
    sourceRevision: "fixture-authority-revision",
    resourceSpaceIds: ["filesystem"],
    allowedCapabilities: ["fs:read"],
    controlBasisDigest: "d",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "d",
  requestedAt: "t",
} as never;

const runProvider = <A, E>(
  providerLayer: Layer.Layer<ProviderPort>,
  program: Effect.Effect<A, E, ProviderPort>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, providerLayer) as Effect.Effect<A, E, never>,
  );

describe("-acceptance story 12 — real provider adapter + non-minimal tool", () => {
  it("story 12: the real adapter emits canonical events, the catalog resolves the model, and `list` runs the unchanged P4 pipeline", async () => {
    const selected = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([
        { type: "text", text: "hello" },
        { type: "completed", finishReason: "stop" },
      ]),
    });
    const events = await runProvider(
      selected,
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        const chunk = yield* Stream.runCollect(
          provider.runTurn({
            request: providerRequest,
            context: providerContext,
          }),
        );
        return Array.from(chunk);
      }),
    );
    expect(
      events.some(
        (event) =>
          event._tag === "Canonical" && event.event._tag === "TurnCompleted",
      ),
    ).toBe(true);

    const failing = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([], new OpenAISdkError(429, "rate_limit_exceeded")),
    });
    const failure = (await runProvider(
      failing,
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        return yield* Effect.flip(
          Stream.runCollect(
            provider.runTurn({
              request: providerRequest,
              context: providerContext,
            }),
          ),
        );
      }),
    )) as ProviderFailure;
    expect(failure._tag).toBe("ProviderFailure");
    expect(failure.kind).toBe("RateLimited");
    expect(providerFailureDisposition(failure.kind)).toBe("retryable");

    expect(
      resolveModelCatalogEntry(DEFAULT_MODEL_CATALOG, "model-openai")
        ?.adapterId,
    ).toBe("provider-openai");
    const capabilityError = await Effect.runPromise(
      Effect.flip(resolveModelCapability(DEFAULT_MODEL_CATALOG, "ghost")),
    );
    expect(capabilityError._tag).toBe("ModelCapabilityError");
    expect([...PROVIDER_FAILURE_KINDS].sort()).toEqual([
      "AuthenticationFailed",
      "AuthorizationFailed",
      "Cancelled",
      "ContextLimitExceeded",
      "ProtocolViolation",
      "ProviderUnavailable",
      "QuotaExceeded",
      "RateLimited",
      "RequestRejected",
      "StreamInterrupted",
      "TransportFailed",
      "UnknownProviderFailure",
    ]);

    const root = mkdtempSync(join(tmpdir(), "p12-acceptance-tool-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "sub", "b.txt"), "b");
    const txFake = Layer.succeed(TransactionPort, {
      transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
        Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
    } as never);
    const toolDeps = Layer.mergeAll(
      txFake,
      ToolDefinitionStoreLive,
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "s",
            rootPath: root,
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      } as never),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: () => Effect.succeed("Recorded" as const),
        settle: () => Effect.succeed(true),
        consumeApproval: () => Effect.succeed(true),
        recordNoEffectDenial: () =>
          Effect.die(new Error("unexpected no-effect denial")),
        recordNoEffectInterruption: () => Effect.succeed(false),
        admitEffect: () => Effect.succeed({ _tag: "Admitted" as const }),
        findApproval: () => Effect.succeed(Option.none()),
        findById: () => Effect.succeed(Option.none()),
        findUnsettled: () => Effect.succeed([]),
      } as never),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: (_p: ProjectId, addresses: ReadonlyArray<unknown>) =>
          Effect.succeed({
            regions: addresses.map((address) => ({
              resourceSpaceId: "filesystem",
              normalizedRegion: address,
            })),
            observedEnvironmentRevision: "rev",
          }),
      }),
      Layer.succeed(WorkspaceRepository, {
        findById: () =>
          Effect.succeed(
            Option.some({
              projectId: parse(ProjectId)(
                "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
              ),
              resourceBoundary: {
                addresses: [{ _tag: "GitWorktree", path: root }],
              },
            }),
          ),
      } as never),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-01-01T00:00:00.000Z"),
      }),
    );
    const toolApp = Layer.mergeAll(
      toolDeps,
      Layer.provide(ToolRuntimeLive(BUILTIN_EXECUTORS), toolDeps),
    );
    const listInvocation = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              callRef: "c",
              toolName: "list",
              toolVersion: "2",
              argumentsJson: JSON.stringify({
                target: { mount: "workspace", path: "." },
                depth: 2,
              }),
              invocationId: parse(ToolInvocationId)(
                "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
              ),
              approvalId: null,
            } as never,
            story12ToolContext,
          );
        }),
        toolApp,
      ) as Effect.Effect<{ _tag: string }, unknown, never>,
    );
    expect(listInvocation._tag).toBe("Success");
  });
});
