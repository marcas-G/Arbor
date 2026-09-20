import {
  ProjectRepository,
  type ProjectRepositoryService,
  SessionRepository,
  type SessionRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { type CommandHandler, CommandHandlerRegistry } from "../gateway.js";
import { makeCreateChildWorkspaceHandler } from "./create-child-workspace.js";
import { makeCreateProjectHandler } from "./create-project.js";

export interface P1CommandDependencies {
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly sessions: SessionRepositoryService;
}

export const makeP1CommandHandlers = (
  dependencies: P1CommandDependencies,
): ReadonlyArray<CommandHandler<unknown, unknown>> => [
  makeCreateProjectHandler(dependencies) as unknown as CommandHandler<
    unknown,
    unknown
  >,
  makeCreateChildWorkspaceHandler(dependencies) as unknown as CommandHandler<
    unknown,
    unknown
  >,
];

export const P1CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  ProjectRepository | WorkspaceRepository | SessionRepository
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const handlers = makeP1CommandHandlers({
      projects,
      workspaces,
      sessions,
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
