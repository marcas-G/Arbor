import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream as StreamNS } from "effect";
import { Effect, Layer, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  type OpenAISdkChunk,
  type OpenAISdkClient,
  OpenAISdkError,
} from "../adapters/provider-openai/src/index.js";
import { selectProviderLayer } from "../apps/single-workspace/src/composition.js";
import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  DEFAULT_MODEL_CATALOG,
  ModelCapabilityPortLive,
  resolveModelCapability,
  resolveModelCatalogEntry,
} from "../packages/model-context/src/index.js";
import {
  type CanonicalProviderEvent,
  Clock,
  ModelCapabilityPort,
  type PortableModelRequest,
  PROVIDER_FAILURE_KINDS,
  ProjectEnvironmentPort,
  type ProviderExecutionContext,
  type ProviderFailure,
  ProviderPort,
  type ProviderPortService,
  providerFailureDisposition,
  ResourceAdmission,
  SandboxPort,
  type ToolExecutionContext,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
} from "../packages/ports/dist/index.js";
import {
  BUILTIN_EXECUTORS,
  BUILTIN_TOOLS,
  LIST_DEFINITION,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "../packages/tool-runtime/src/index.js";

/**
 * P12-011 (`12` §1–§7; EC-12):
 *  - `adapters/provider-openai` exists, implements `ProviderPort`, is selected
 *    at the Composition Root via the model catalog `adapterId`;
 *  - an injected SDK error surfaces as `ProviderFailure` and the `E` channel
 *    contains no SDK/transport type (DID §0A.6);
 *  - the model catalog resolves `modelRef` -> adapter + capability
 *    deterministically; unknown -> typed `ModelCapabilityError`;
 *  - the real `ModelCapabilityPort` replaces the static fake;
 *  - `ProviderFailureKind` is a closed union whose six frozen tags keep their
 *    retry dispositions (TR-4);
 *  - a non-`read`/`patch`/`shell` tool runs the unchanged P4 pipeline.
 */

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const request: PortableModelRequest = {
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
  timeoutMs: 1000,
  cancellationRef: "cancel-1",
};

const sdkClient = (
  chunks: ReadonlyArray<OpenAISdkChunk>,
  error?: OpenAISdkError,
): OpenAISdkClient => ({
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

const runProvider = <A, E>(
  layer: Layer.Layer<ProviderPort>,
  program: Effect.Effect<A, E, ProviderPort>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, layer) as Effect.Effect<A, E, never>,
  );

const collectEvents = (
  layer: Layer.Layer<ProviderPort>,
): Promise<ReadonlyArray<CanonicalProviderEvent>> =>
  runProvider(
    layer,
    Effect.gen(function* () {
      const provider = yield* ProviderPort;
      const chunk = yield* Stream.runCollect(
        provider.runTurn({ request, context: providerContext }),
      );
      return Array.from(chunk);
    }),
  );

describe("P12-011 provider adapter", () => {
  it("is selected at the composition root and emits canonical events", async () => {
    const selected = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([
        { type: "text", text: "hello" },
        { type: "usage", inputTokens: 3, outputTokens: 4 },
        { type: "completed", finishReason: "stop" },
      ]),
    });
    const events = await collectEvents(selected);
    expect(events.map((event) => event._tag)).toEqual([
      "TurnStarted",
      "TextDelta",
      "UsageReported",
      "TurnCompleted",
    ]);
    const completed = events.find((event) => event._tag === "TurnCompleted");
    expect(completed?._tag === "TurnCompleted" && completed.finishReason).toBe(
      "Stop",
    );
  });

  it("translates an injected SDK error to ProviderFailure (retryable class)", async () => {
    const selected = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([], new OpenAISdkError(429, "rate_limit_exceeded")),
    });
    const failure = await runProvider(
      selected,
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        return yield* Effect.flip(
          Stream.runCollect(
            provider.runTurn({ request, context: providerContext }),
          ),
        );
      }),
    );
    expect(failure._tag).toBe("ProviderFailure");
    expect(failure.kind).toBe("RateLimited");
    expect(providerFailureDisposition(failure.kind)).toBe("retryable");
    // No SDK type leaks into the error channel value.
    expect(failure instanceof OpenAISdkError).toBe(false);
    expect((failure as { name?: string }).name).not.toBe("OpenAISdkError");
  });

  it("normalizes an unknown provider class to ProtocolViolation (terminal)", async () => {
    const selected = selectProviderLayer({
      adapterId: "provider-openai",
      client: sdkClient([], new OpenAISdkError(418, "no_such_provider_class")),
    });
    const failure = await runProvider(
      selected,
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        return yield* Effect.flip(
          Stream.runCollect(
            provider.runTurn({ request, context: providerContext }),
          ),
        );
      }),
    );
    expect(failure.kind).toBe("ProtocolViolation");
    expect(providerFailureDisposition(failure.kind)).toBe("terminal");
  });

  it("E channel contains no SDK/transport type (DID §0A.6)", () => {
    type RunError = StreamNS.Error<ReturnType<ProviderPortService["runTurn"]>>;
    type Expect<T extends true> = T;
    type ClosedToProviderFailure = Expect<
      [RunError] extends [ProviderFailure] ? true : false
    >;
    type NoSdkInError = Expect<
      [Extract<RunError, OpenAISdkError>] extends [never] ? true : false
    >;
    const closed: ClosedToProviderFailure = true;
    const noSdk: NoSdkInError = true;
    expect(closed).toBe(true);
    expect(noSdk).toBe(true);
  });
});

describe("P12-011 model catalog / model capability", () => {
  it("deterministically resolves modelRef -> adapter + capability; unknown -> typed error", async () => {
    const openai = resolveModelCatalogEntry(
      DEFAULT_MODEL_CATALOG,
      "model-openai",
    );
    expect(openai?.adapterId).toBe("provider-openai");
    expect(openai?.capability.modelRef).toBe("model-openai");

    const fake = resolveModelCatalogEntry(DEFAULT_MODEL_CATALOG, "model-fake");
    expect(fake?.adapterId).toBe("provider-fake");

    expect(
      resolveModelCatalogEntry(DEFAULT_MODEL_CATALOG, "ghost"),
    ).toBeUndefined();

    const error = await Effect.runPromise(
      Effect.flip(resolveModelCapability(DEFAULT_MODEL_CATALOG, "ghost")),
    );
    expect(error._tag).toBe("ModelCapabilityError");
  });

  it("real ModelCapabilityPort backed by the catalog replaces the static fake", async () => {
    const capability = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const port = yield* ModelCapabilityPort;
          return yield* port.resolve({
            binding: {
              _tag: "ResponsibilityBoundAgentBinding" as const,
              workspaceId,
            },
            cognitiveMode: "execute",
            requiredCapabilities: [],
          });
        }),
        ModelCapabilityPortLive(DEFAULT_MODEL_CATALOG),
      ),
    );
    expect(capability.modelRef).toBe(DEFAULT_MODEL_CATALOG.defaultModelRef);
    expect(capability.contextWindow).toBeGreaterThan(0);
    expect(capability.outputCeiling).toBeGreaterThan(0);
  });

  it("selects a model satisfying the required capabilities deterministically", async () => {
    const capability = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const port = yield* ModelCapabilityPort;
          return yield* port.resolve({
            binding: {
              _tag: "ResponsibilityBoundAgentBinding" as const,
              workspaceId,
            },
            cognitiveMode: "execute",
            requiredCapabilities: ["tools"],
          });
        }),
        ModelCapabilityPortLive(DEFAULT_MODEL_CATALOG),
      ),
    );
    expect(
      DEFAULT_MODEL_CATALOG.entries.some(
        (entry) => entry.modelRef === capability.modelRef,
      ),
    ).toBe(true);
  });
});

describe("P12-011 ProviderFailureKind closed-union disposition (TR-4)", () => {
  it("carries exactly the six frozen tags with frozen retry dispositions", () => {
    expect([...PROVIDER_FAILURE_KINDS].sort()).toEqual([
      "AuthenticationFailed",
      "ProtocolViolation",
      "ProviderUnavailable",
      "RateLimited",
      "RequestRejected",
      "StreamInterrupted",
    ]);
    expect(providerFailureDisposition("RateLimited")).toBe("retryable");
    expect(providerFailureDisposition("ProviderUnavailable")).toBe("retryable");
    expect(providerFailureDisposition("StreamInterrupted")).toBe("retryable");
    expect(providerFailureDisposition("AuthenticationFailed")).toBe("terminal");
    expect(providerFailureDisposition("RequestRejected")).toBe("terminal");
    expect(providerFailureDisposition("ProtocolViolation")).toBe("terminal");
  });
});

const authority = {
  principal,
  workspaceId,
  executionId,
  toolName: "list",
  toolVersion: "1",
  resourceSpaceIds: ["filesystem"],
  allowedCapabilities: ["fs:read"],
  controlBasisDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  delegationDepth: 0,
};

const toolContext = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority,
  controlBasisDigest: "d",
  requestedAt: "t",
} as ToolExecutionContext;

const toolIntent = {
  callRef: "c",
  toolName: "list",
  toolVersion: "1",
  argumentsJson: JSON.stringify({
    path: { _tag: "FileTree", path: "." },
    depth: 2,
  }),
  invocationId,
  approvalId: null,
};

const makeToolApp = (root: string) => {
  const tx = Layer.succeed(TransactionPort, {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
  });
  const deps = Layer.mergeAll(
    tx,
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
      recordIntent: () => Effect.void,
      settle: () => Effect.void,
      consumeApproval: () => Effect.succeed(true),
      findApproval: () => Effect.succeed(Option.none()),
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
    Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-01-01T00:00:00.000Z"),
    }),
  );
  return Layer.mergeAll(
    deps,
    Layer.provide(ToolRuntimeLive(BUILTIN_EXECUTORS), deps),
  );
};

describe("P12-011 non-minimal tool through the unchanged P4 pipeline", () => {
  it("registers a versioned non-read/patch/shell builtin with real schemas", () => {
    expect(BUILTIN_TOOLS.some((tool) => tool.name === "list")).toBe(true);
    expect(LIST_DEFINITION.name).toBe("list");
    expect(LIST_DEFINITION.version).toBe("1");
    expect(LIST_DEFINITION.source).toBe("Builtin");
    expect(LIST_DEFINITION.inputSchemaJson).not.toBe("{}");
    expect(LIST_DEFINITION.resultSchemaJson).not.toBe("{}");
  });

  it("executes `list` through validation -> authority -> admission -> sandbox -> settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "p12-tools-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "sub", "b.txt"), "b");

    const app = makeToolApp(root);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(toolIntent as never, toolContext);
        }),
        app,
      ) as Effect.Effect<{ _tag: string }, unknown, never>,
    );
    expect(result._tag).toBe("Success");
    const observation = (result as { observation?: { text: string } })
      .observation;
    const parsed = JSON.parse(observation?.text ?? "{}") as {
      entries: ReadonlyArray<string>;
    };
    expect(parsed.entries).toContain("a.txt");
    expect(parsed.entries).toContain("sub/");
  });
});
