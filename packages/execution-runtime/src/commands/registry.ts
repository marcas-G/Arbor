import {
  type CommandHandler,
  CommandHandlerRegistry,
} from "@arbor/application";
import {
  ExecutableApprovalStore,
  ExecutionRepository,
  ProjectRepository,
  SessionRepository,
  WorkReadmissionGateStore,
  WorkspaceRepository,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { makeAdmitExecutionHandler } from "./admit-execution.js";
import { makeSettleExecutionHandler } from "./settle-execution.js";
import { makeStopExecutionHandler } from "./stop-execution.js";

export interface P2CommandDependencies {
  readonly projects: import("@arbor/ports").ProjectRepositoryService;
  readonly workspaces: import("@arbor/ports").WorkspaceRepositoryService;
  readonly sessions: import("@arbor/ports").SessionRepositoryService;
  readonly executions: import("@arbor/ports").ExecutionRepositoryService;
  readonly readmissionGate?: import("@arbor/ports").WorkReadmissionGateStoreService;
  readonly workWaits: import("@arbor/ports").WorkWaitStoreService;
  readonly blockers?: import("@arbor/ports").WorkBlockerStoreService;
  readonly works?: Pick<
    import("@arbor/ports").WorkRepositoryService,
    "findById"
  >;
  readonly inbox?: Pick<
    import("@arbor/ports").InboxProjectionStoreService,
    "currentSequence"
  >;
  readonly blockedEvidence?: import("@arbor/application").BlockedEvidenceDependencies;
  readonly executableApprovals?: Pick<
    import("@arbor/ports").ExecutableApprovalStoreService,
    "cancelForExecution"
  >;
}

export const makeP2CommandHandlers = (
  dependencies: P2CommandDependencies,
): ReadonlyArray<CommandHandler<unknown, unknown>> => {
  const readmissionGate = dependencies.readmissionGate ?? {
    hasBlockingSource: () =>
      Effect.fail({
        _tag: "PersistenceUnavailable" as const,
        repository: "WorkReadmissionGateStore" as const,
        operation: "AdmitExecution",
        retryDisposition: "non-retryable" as const,
        sourceTag: "ReadmissionGateUnavailable",
        cause: "readmission gate service is not registered",
      }),
  };
  const executableApprovals = dependencies.executableApprovals ?? {
    // Test/legacy compositions without the P38 port fail closed on Stop;
    // production SingleWorkspace composition always supplies the real store.
    cancelForExecution: () =>
      Effect.fail({
        _tag: "PersistenceUnavailable" as const,
        repository: "ToolInvocationStore" as const,
        operation: "StopExecution.ExecutableApprovalCancellation",
        retryDisposition: "non-retryable" as const,
        sourceTag: "ExecutableApprovalStoreUnavailable",
        cause: "ordered P38 store is not registered",
      }),
  };
  return [
    makeAdmitExecutionHandler({
      ...dependencies,
      readmissionGate,
    }) as unknown as CommandHandler<unknown, unknown>,
    makeStopExecutionHandler({
      executions: dependencies.executions,
      executableApprovals,
    }) as unknown as CommandHandler<unknown, unknown>,
    makeSettleExecutionHandler(dependencies) as unknown as CommandHandler<
      unknown,
      unknown
    >,
  ];
};

export const P2CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | ExecutionRepository
  | WorkWaitStore
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const executions = yield* ExecutionRepository;
    const readmissionGate = yield* Effect.serviceOption(
      WorkReadmissionGateStore,
    );
    const workWaits = yield* WorkWaitStore;
    const executableApprovals = yield* Effect.serviceOption(
      ExecutableApprovalStore,
    );
    // P38 remains absent from production composition until 0037→0038 is
    // registered. When the ordered store is supplied, StopExecution composes
    // its cancellation in the same Gateway TransactionScope.
    const handlers = makeP2CommandHandlers({
      projects,
      workspaces,
      sessions,
      executions,
      ...(Option.isSome(readmissionGate)
        ? { readmissionGate: readmissionGate.value }
        : {}),
      workWaits,
      ...(Option.isSome(executableApprovals)
        ? { executableApprovals: executableApprovals.value }
        : {}),
    });
    return CommandHandlerRegistry.of({
      lookup: (commandType) => {
        const handler = handlers.find(
          (candidate) => candidate.commandType === commandType,
        );
        return handler === undefined ? Option.none() : Option.some(handler);
      },
    });
  }),
);
