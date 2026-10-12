import {
  AuthorityResolverPortLive,
  type ParentUserGovernanceFacts,
} from "@arbor/application";
import {
  ExecutionId,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  type NoEffectDenialCode,
  PermissionGrantRepository,
  ProjectEnvironmentPort,
  ProjectRepository,
  ResourceAdmission,
  SandboxPort,
  ToolCatalogPort,
  type ToolInvocationIntent,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
  VerificationRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import {
  PATCH_DEFINITION,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "@arbor/tool-runtime";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutableToolHandler } from "../src/executable-tool-handler.js";
import { ToolAuthorityResolverLive } from "../src/tool-authority-resolver.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:authority-denial-test");
const governance: ParentUserGovernanceFacts = {
  authenticatedHumans: [],
  directParentOf: [],
};
const now = "2026-10-12T00:00:00.000Z";

const workspaceRecord = {
  projectId,
  resourceBoundary: {
    addresses: [{ _tag: "FileTree" as const, path: "C:/authority-denial" }],
  },
  workspacePolicy: makeWorkspacePolicy({ delegationCeiling: 0 }),
  workspacePolicyRevision: 0,
};

const transaction = Layer.succeed(TransactionPort, {
  transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
    Effect.provideService(body, TransactionScope, {
      session: { id: "authority-denial-production-pipeline" },
    }),
});

const workspaceRepository = Layer.succeed(WorkspaceRepository, {
  findById: () => Effect.succeed(Option.some(workspaceRecord)),
} as never);

const makeProductionPipeline = (projectLookupOperationalFailure: boolean) => {
  const projectRepository = Layer.succeed(ProjectRepository, {
    findById: () =>
      projectLookupOperationalFailure
        ? Effect.fail({ _tag: "InjectedOperationalFailure" as const })
        : Effect.succeed(Option.none()),
  } as never);
  const authorityDependencies = Layer.mergeAll(
    AuthorityResolverPortLive,
    transaction,
    projectRepository,
    workspaceRepository,
    Layer.succeed(PermissionGrantRepository, {
      activeGrants: () => Effect.succeed([]),
    } as never),
    Layer.succeed(VerificationRepository, {
      findByExecutionId: () => Effect.succeed(Option.none()),
    } as never),
  );
  const productionAuthority = Layer.provide(
    ToolAuthorityResolverLive(governance),
    authorityDependencies,
  );

  let executorCalls = 0;
  const runtimeDependencies = Layer.mergeAll(
    transaction,
    workspaceRepository,
    ToolDefinitionStoreLive,
    Layer.succeed(SandboxPort, {
      open: () =>
        Effect.succeed({
          handleId: "authority-denial-sandbox",
          rootPath: "C:/authority-denial",
          writableRegions: [],
        }),
      close: () => Effect.succeed(true),
    } as never),
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    } as never),
    Layer.succeed(ToolInvocationStore, {
      recordIntent: () => Effect.void,
      settle: () => Effect.succeed(true),
      consumeApproval: () => Effect.succeed(true),
      recordNoEffectDenial: (
        invocation: ToolInvocationIntent,
        reasonCode: NoEffectDenialCode,
        settledAt: string,
      ) =>
        Effect.succeed({
          ...invocation,
          effectAdmissionState: "NotAdmitted" as const,
          settlement: { _tag: "Denied" as const, reasonCode },
          settledAt,
          resultRef: null,
        }),
      findApproval: () => Effect.succeed(Option.none()),
      findById: () => Effect.succeed(Option.none()),
      findUnsettled: () => Effect.succeed([]),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_project, addresses) =>
        Effect.succeed({
          regions: addresses.map((address) => ({
            resourceSpaceId: "filesystem",
            normalizedRegion: address,
          })),
          observedEnvironmentRevision: "environment-revision-test",
        }),
    }),
    Layer.succeed(Clock, { now: () => Effect.succeed(now) }),
    productionAuthority,
  );
  const runtime = Layer.provide(
    ToolRuntimeLive(
      [
        {
          name: PATCH_DEFINITION.name,
          write: true,
          requiresApproval: () => false,
          execute: () =>
            Effect.sync(() => {
              executorCalls += 1;
              return {
                settlement: { _tag: "Success" as const },
                observation: { text: "patch executed", truncated: false },
                resultRef: null,
              };
            }),
        },
      ],
      { now },
    ),
    runtimeDependencies,
  );
  const catalog = {
    visibleRefs: () =>
      Effect.succeed([
        {
          name: PATCH_DEFINITION.name,
          version: PATCH_DEFINITION.version,
          hash: PATCH_DEFINITION.hash,
        },
      ]),
    resolveForModel: () => Effect.die("unused in executable observation test"),
  };

  return {
    executorCalls: () => executorCalls,
    layer: Layer.mergeAll(
      runtime,
      Layer.succeed(ToolCatalogPort, catalog),
      Layer.succeed(Clock, { now: () => Effect.succeed(now) }),
    ),
  };
};

type ExecutablePipelineLayer = Layer.Layer<
  ToolRuntimePort | ToolCatalogPort | Clock,
  never,
  never
>;

const invokeExecutable = (layer: ExecutablePipelineLayer) =>
  Effect.provide(
    Effect.gen(function* () {
      const runtime = yield* ToolRuntimePort;
      const clock = yield* Clock;
      return yield* makeExecutableToolHandler(runtime, clock, {
        visibleRefs: () =>
          Effect.succeed([
            {
              name: PATCH_DEFINITION.name,
              version: PATCH_DEFINITION.version,
              hash: PATCH_DEFINITION.hash,
            },
          ]),
        resolveForModel: () =>
          Effect.die("unused in executable observation test"),
      }).handle({
        invocation: {
          providerTurnId: "ptn_authority-denial" as never,
          outputPosition: 0,
          callRef: "call-authority-denial",
          toolName: PATCH_DEFINITION.name,
          argumentsJson: JSON.stringify({
            target: { mount: "workspace", path: "." },
            unifiedDiff: "--- a/file\n+++ b/file\n@@\n-old\n+new\n",
          }),
        },
        execution: {
          executionId,
          projectId,
          workspaceId,
          sessionId,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId,
            focus: { _tag: "Work", workId },
          },
          admittedAt: now,
          stopRequestedAt: null,
          state: { status: "Active", settlement: null },
        },
        context: {
          _tag: "ExecutionOrigin",
          principal,
          executionId,
          workerId: "worker:authority-denial-test",
          workerIncarnationId: "incarnation:authority-denial-test",
          fencingGeneration: 0 as never,
        },
        controlBasis: {} as never,
      });
    }),
    layer,
  );

describe("production authority denial executable path", () => {
  it("turns policy denial into a Denied observation and keeps resolver faults operational", async () => {
    const deniedPipeline = makeProductionPipeline(false);
    const observation = await Effect.runPromise(
      invokeExecutable(deniedPipeline.layer),
    );

    expect(observation).toMatchObject({
      _tag: "Observation",
      source: "Runtime",
      status: "Denied",
    });
    expect(deniedPipeline.executorCalls()).toBe(0);

    const failedPipeline = makeProductionPipeline(true);
    const operationalFailure = await Effect.runPromise(
      Effect.flip(invokeExecutable(failedPipeline.layer)),
    );

    expect(operationalFailure).toMatchObject({
      _tag: "AgentActionOperationalFailure",
      operation: "ToolRuntime.AuthorityResolution",
    });
    expect(failedPipeline.executorCalls()).toBe(0);
  });
});
