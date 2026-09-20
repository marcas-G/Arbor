import {
  type CommandHandler,
  CommandHandlerRegistry,
} from "@arbor/application";
import {
  ExecutionRepository,
  ProjectRepository,
  SessionRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { makeAdmitExecutionHandler } from "./admit-execution.js";

export const P2CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | ExecutionRepository
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const executions = yield* ExecutionRepository;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      makeAdmitExecutionHandler({
        projects,
        workspaces,
        sessions,
        executions,
      }) as unknown as CommandHandler<unknown, unknown>,
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
