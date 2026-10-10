import { appendFileSync } from "node:fs";
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
  ToolRuntimePort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { ToolRuntimeLive } from "../../../../packages/tool-runtime/dist/index.js";
import {
  layer,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../../dist/index.js";

const databaseFile = process.env.ARBOR_AH7_DB;
const effectLogPath = process.env.ARBOR_AH7_EFFECT_LOG;
const workerName = process.env.ARBOR_AH7_WORKER;
const pauseAfterEffect = process.env.ARBOR_AH7_PAUSE_AFTER_EFFECT === "1";
if (
  databaseFile === undefined ||
  effectLogPath === undefined ||
  workerName === undefined
) {
  throw new Error(
    "AH7 child requires database, effect log, and worker identity",
  );
}

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("worker:ah7-cross-process");
const actor = parse(Actor)("worker:ah7-cross-process");

const definition = {
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
  callRef: "call-ah7-cross-process",
  toolName: definition.name,
  toolVersion: definition.version,
  argumentsJson: "{}",
  invocationId,
  approvalId: null,
};
const context = {
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
    controlBasisDigest: "ah7-cross-process-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "ah7-cross-process-basis",
  requestedAt: "2026-10-07T00:00:00.000Z",
};

const waitForRelease = () =>
  new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== "go") return;
      process.off("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
    process.send(
      { type: "ready", worker: workerName, pid: process.pid },
      (error) => {
        if (error) {
          process.off("message", onMessage);
          reject(error);
        }
      },
    );
  });

const executor = {
  name: definition.name,
  write: true,
  requiresApproval: () => false,
  execute: () =>
    Effect.sync(() => {
      appendFileSync(effectLogPath, "AH7_NONIDEMPOTENT_CROSS_PROCESS_EFFECT\n");
      return {
        settlement: { _tag: "Success" },
        observation: { text: "external effect appended", truncated: false },
        resultRef: null,
      };
    }),
};

const qualificationProbe = async (event) => {
  if (
    !pauseAfterEffect ||
    workerName !== "worker-a" ||
    event.boundary !== "AH7AfterToolEffectBeforeSettlement"
  ) {
    return;
  }
  await new Promise((resolveRelease, rejectRelease) => {
    const onMessage = (message) => {
      if (message?.type !== "release-settlement") return;
      process.off("message", onMessage);
      resolveRelease();
    };
    process.on("message", onMessage);
    process.send({ type: "effect-ready", worker: workerName }, (error) => {
      if (error) {
        process.off("message", onMessage);
        rejectRelease(error);
      }
    });
  });
};

const sqlite = layer({ filename: databaseFile });
const infrastructure = Layer.mergeAll(
  sqlite,
  Layer.provide(TransactionPortLive, sqlite),
  Layer.provide(ToolInvocationStoreLive, sqlite),
);
const dependencies = Layer.mergeAll(
  infrastructure,
  Layer.succeed(ToolDefinitionStore, {
    definition: () =>
      Effect.promise(waitForRelease).pipe(Effect.as(Option.some(definition))),
    all: () => Effect.succeed([definition]),
  }),
  Layer.succeed(SandboxPort, {
    open: () =>
      Effect.succeed({
        handleId: `ah7-cross-process-${workerName}`,
        rootPath: "/repo",
        writableRegions: [],
      }),
    close: () => Effect.void,
  }),
  Layer.succeed(ResourceAdmission, {
    admit: () => Effect.succeed({ _tag: "Admitted" }),
  }),
  Layer.succeed(ProjectEnvironmentPort, {
    resolve: () =>
      Effect.succeed({
        regions: [],
        observedEnvironmentRevision: "env-ah7-cross-process",
      }),
  }),
  Layer.succeed(Clock, {
    now: () => Effect.succeed("2026-10-07T00:00:00.000Z"),
  }),
);
const app = Layer.mergeAll(
  dependencies,
  Layer.provide(
    ToolRuntimeLive([executor], { qualificationProbe }),
    dependencies,
  ),
);

try {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* Effect.match(runtime.invoke(intent, context), {
            onFailure: (error) => ({
              outcome: "Rejected",
              errorTag: error?._tag ?? "unknown",
              stage: error?.stage ?? null,
            }),
            onSuccess: (value) => ({
              outcome: value?._tag ?? "unknown",
              errorTag: null,
              stage: null,
            }),
          });
        }),
        app,
      ),
    ),
  );
  process.send({ type: "result", worker: workerName, result }, () => {
    process.disconnect();
  });
} catch (error) {
  process.send(
    {
      type: "error",
      worker: workerName,
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    },
    () => process.disconnect(),
  );
}
