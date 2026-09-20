import {
  type CommandHandler,
  CommandHandlerRegistry,
} from "@arbor/application";
import {
  ExecutionRepository,
  ProjectRepository,
  SessionRepository,
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
  readonly workWaits: import("@arbor/ports").WorkWaitStoreService;
}

export const makeP2CommandHandlers = (
  dependencies: P2CommandDependencies,
): ReadonlyArray<CommandHandler<unknown, unknown>> => [
  makeAdmitExecutionHandler(dependencies) as unknown as CommandHandler<
    unknown,
    unknown
  >,
  makeStopExecutionHandler(dependencies) as unknown as CommandHandler<
    unknown,
    unknown
  >,
  makeSettleExecutionHandler(dependencies) as unknown as CommandHandler<
    unknown,
    unknown
  >,
];

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
    const workWaits = yield* WorkWaitStore;
    const handlers = makeP2CommandHandlers({
      projects,
      workspaces,
      sessions,
      executions,
      workWaits,
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
