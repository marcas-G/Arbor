import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  ToolDefinitionStore,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ToolDefinitionStoreLive,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../src/index.js";

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

const authority = {
  principal,
  workspaceId,
  executionId,
  toolName: "read",
  toolVersion: "1",
  resourceSpaceIds: ["filesystem"],
  allowedCapabilities: ["fs:read"],
  controlBasisDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  delegationDepth: 0,
};
const context = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority,
  controlBasisDigest: "d",
  requestedAt: "t",
} as import("@arbor/ports").ToolExecutionContext;
const intent = (argumentsJson: string) => ({
  callRef: "c",
  toolName: "read",
  toolVersion: "1",
  argumentsJson,
  invocationId,
  approvalId: null,
});

const okExecutor: ToolExecutor = {
  name: "read",
  write: false,
  requiresApproval: false,
  execute: () =>
    Effect.succeed({
      settlement: { _tag: "Success" },
      observation: { text: "ok", truncated: false },
      resultRef: null,
    }),
};

const app = (admissionDeny = false, executor: ToolExecutor = okExecutor) => {
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
          rootPath: "/tmp/s",
          writableRegions: [],
        }),
      close: () => Effect.void,
    }),
    Layer.succeed(ResourceAdmission, {
      admit: () =>
        Effect.succeed(
          admissionDeny
            ? { _tag: "Denied" as const, reason: "no" }
            : { _tag: "Admitted" as const },
        ),
    } as never),
    Layer.succeed(ToolInvocationStore, {
      recordIntent: () => Effect.void,
      settle: () => Effect.void,
      consumeApproval: () => Effect.succeed(true),
      findApproval: () => Effect.succeed(Option.none()),
      findUnsettled: () => Effect.succeed([]),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_p, addresses) =>
        Effect.succeed({
          regions: addresses.map((a) => ({
            resourceSpaceId: "filesystem",
            normalizedRegion: a,
          })),
          observedEnvironmentRevision: "rev",
        }),
    }),
    Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-01-01T00:00:00.000Z"),
    }),
  );
  return Layer.mergeAll(deps, Layer.provide(ToolRuntimeLive([executor]), deps));
};

const run = (appLayer: Layer.Layer<any, any, any>, argumentsJson: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(intent(argumentsJson) as never, context);
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

describe("P4 tool runtime pipeline", () => {
  it("runs the pipeline and returns Success", async () => {
    const result = await run(
      app(),
      '{"path":{"_tag":"FileTree","path":"/repo/a"}}',
    );
    expect(result._tag).toBe("Success");
  });

  it("returns ExpectedFailure on invalid input", async () => {
    const result = await run(app(), "{}");
    expect(result._tag).toBe("ExpectedFailure");
  });

  it("returns Denied when admission denies", async () => {
    const result = await run(
      app(true),
      '{"path":{"_tag":"FileTree","path":"/repo/a"}}',
    );
    expect(result._tag).toBe("Denied");
  });

  it("returns Denied for an unknown tool", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            { ...intent("{}"), toolName: "nope" } as never,
            context,
          );
        }),
        app(),
      ) as Effect.Effect<{ _tag: string }, unknown, never>,
    );
    expect(result._tag).toBe("Denied");
  });

  it("requires approval when the executor demands it", async () => {
    const approvalExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: true,
      execute: okExecutor.execute,
    };
    const result = await run(
      app(false, approvalExecutor),
      '{"path":{"_tag":"FileTree","path":"/repo/a"}}',
    );
    expect(result._tag).toBe("Denied");
  });

  void ToolDefinitionStore;
});
