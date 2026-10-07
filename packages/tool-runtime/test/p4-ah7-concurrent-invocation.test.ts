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
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolInvocationRecord,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { type ToolExecutor, ToolRuntimeLive } from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:ah7-concurrent");
const actor = parse(Actor)("worker:ah7-concurrent");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const argumentsJson = "{}";

const definition: ToolDefinition = {
  name: "write_once",
  version: "1",
  hash: "write-once-v1",
  description: "Perform a non-idempotent side effect.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "NonIdempotent",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-concurrent",
  toolName: definition.name,
  toolVersion: definition.version,
  argumentsJson,
  invocationId,
  approvalId: null,
} as const;

const context: ToolExecutionContext = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority: {
    principal,
    workspaceId,
    executionId,
    toolName: intent.toolName,
    toolVersion: intent.toolVersion,
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "ah7-concurrent-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "ah7-concurrent-basis",
  requestedAt: "2026-10-06T00:00:00.000Z",
};

describe("AH7 concurrent ToolInvocationId reentry", () => {
  it("admits one intent and one non-idempotent effect; the racing duplicate fails closed", async () => {
    let invocation: ToolInvocationRecord | undefined;
    let firstLookupCount = 0;
    let releaseInitialLookups: (() => void) | undefined;
    const initialLookupsReady = new Promise<void>((resolve) => {
      releaseInitialLookups = resolve;
    });
    let intentWrites = 0;
    let settlementWrites = 0;
    let executorEffects = 0;

    const executor: ToolExecutor = {
      name: definition.name,
      write: true,
      requiresApproval: () => false,
      execute: () => {
        executorEffects += 1;
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: { text: "effect applied once", truncated: false },
          resultRef: null,
        });
      },
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(TransactionPort, {
        transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
          Effect.provideService(body, TransactionScope, {
            session: { id: "ah7-concurrent-invocation" },
          }),
      }),
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(definition)),
        all: () => Effect.succeed([definition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "ah7-concurrent-sandbox",
            rootPath: "/repo",
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      }),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: () =>
          Effect.succeed({
            regions: [],
            observedEnvironmentRevision: "ah7-concurrent-env",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-06T00:00:00.000Z"),
      }),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: (record: ToolInvocationRecord) => {
          if (invocation !== undefined) {
            return Effect.fail({
              _tag: "PersistenceUnavailable" as const,
              repository: "ToolInvocationStore" as const,
              operation: "record-intent-duplicate",
              retryDisposition: "retryable" as const,
              sourceTag: "UniqueConstraint" as const,
              cause: "invocation identity already has a durable intent",
            });
          }
          intentWrites += 1;
          invocation = {
            ...record,
            settledAt: null,
            settlement: null,
            resultRef: null,
          };
          return Effect.void;
        },
        settle: (
          id: ToolInvocationRecord["invocationId"],
          settlement: NonNullable<ToolInvocationRecord["settlement"]>,
          resultRef: string | null,
          settledAt: string,
        ) => {
          expect(id).toBe(invocationId);
          if (invocation === undefined) {
            return Effect.die(new Error("settlement without durable intent"));
          }
          settlementWrites += 1;
          invocation = { ...invocation, settledAt, settlement, resultRef };
          return Effect.void;
        },
        consumeApproval: () => Effect.succeed(false),
        findApproval: () => Effect.succeed(Option.none()),
        findById: () =>
          Effect.promise(async () => {
            firstLookupCount += 1;
            if (firstLookupCount <= 2) {
              if (firstLookupCount === 2) releaseInitialLookups?.();
              await initialLookupsReady;
              return Option.none();
            }
            return invocation === undefined
              ? Option.none()
              : Option.some(invocation);
          }),
        findUnsettled: () =>
          Effect.succeed(invocation?.settlement === null ? [invocation] : []),
      } as never),
    );
    const app = Layer.mergeAll(
      dependencies,
      Layer.provide(ToolRuntimeLive([executor]), dependencies),
    );
    const invoke = () =>
      Effect.match(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(intent, context);
        }),
        {
          onFailure: (error) => ({ _tag: "Left" as const, error }),
          onSuccess: (value) => ({ _tag: "Right" as const, value }),
        },
      );

    const outcomes = await Effect.runPromise(
      Effect.provide(Effect.all([invoke(), invoke()], { concurrency: 2 }), app),
    );

    expect(firstLookupCount).toBe(2);
    expect(intentWrites).toBe(1);
    expect(settlementWrites).toBe(1);
    expect(executorEffects).toBe(1);
    expect(invocation).toMatchObject({
      invocationId,
      settlement: { _tag: "Success" },
    });
    expect(outcomes.filter((outcome) => outcome._tag === "Right")).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome._tag === "Left")).toHaveLength(
      1,
    );
    expect(outcomes.find((outcome) => outcome._tag === "Left")).toMatchObject({
      _tag: "Left",
      error: {
        _tag: "ToolRuntimeOperationalFailure",
        stage: "IntentJournal",
      },
    });
  });
});
