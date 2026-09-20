import {
  type CommandHandler,
  CommandHandlerRegistry,
  makeP1CommandHandlers,
} from "@arbor/application";
import { makeP2CommandHandlers } from "@arbor/execution-runtime";
import {
  ExecutionRepository,
  ProjectRepository,
  SessionRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/**
 * The slice's command handler registry: P1 commands (CreateProject /
 * CreateChildWorkspace / AssignWork) + P2 runtime commands (AdmitExecution /
 * StopExecution / SettleExecution). No new command semantics (P5 `01`).
 */
export const SliceCommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const workWaits = yield* WorkWaitStore;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
      ...makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
      }),
    ];
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
