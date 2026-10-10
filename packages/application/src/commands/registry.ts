import {
  type AssignWorkTargetBindingRepositoryService,
  Clock,
  type ClockService,
  type ControlApprovalStoreService,
  type ConversationResponseJobStoreService,
  type ExecutionRepositoryService,
  type InboxProjectionStoreService,
  type PermissionGrantRepositoryService,
  ProjectRepository,
  type ProjectRepositoryService,
  ProjectResourceProfilePort,
  type ProjectResourceProfilePortService,
  type ProjectToolRegistryService,
  SessionRepository,
  type SessionRepositoryService,
  WorkRepository,
  type WorkRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { type CommandHandler, CommandHandlerRegistry } from "../gateway.js";
import { makeAssignWorkHandler } from "./assign-work.js";
import { makeCreateChildWorkspaceHandler } from "./create-child-workspace.js";
import { makeCreateProjectHandler } from "./create-project.js";
import { makeGrantPermissionHandler } from "./grant-permission.js";
import {
  makeCloseProjectHandler,
  makeRenameProjectHandler,
} from "./project-management.js";
import { makeRegisterProjectToolHandler } from "./register-project-tool.js";
import { makeRevokePermissionHandler } from "./revoke-permission.js";

export interface P1CommandDependencies {
  readonly clock?: Pick<ClockService, "now">;
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly sessions: SessionRepositoryService;
  readonly projectResourceProfiles?: ProjectResourceProfilePortService;
  readonly works: WorkRepositoryService;
  readonly executions?: Pick<ExecutionRepositoryService, "findById">;
  readonly bindings?: Pick<AssignWorkTargetBindingRepositoryService, "insert">;
  readonly grants?: Pick<PermissionGrantRepositoryService, "findById">;
  readonly approvals?: Pick<
    ControlApprovalStoreService,
    "findById" | "consumeApproved"
  >;
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
  makeAssignWorkHandler(dependencies) as unknown as CommandHandler<
    unknown,
    unknown
  >,
];

export interface P15CommandDependencies {
  readonly projects: ProjectRepositoryService;
  readonly executions: ExecutionRepositoryService;
  readonly responseJobs: Pick<
    ConversationResponseJobStoreService,
    "listForWorkspace" | "transition"
  >;
  readonly inbox: Pick<InboxProjectionStoreService, "markConsumed">;
}

export const makeP15CommandHandlers = (
  dependencies: P15CommandDependencies,
): ReadonlyArray<CommandHandler<unknown, unknown>> => [
  makeRenameProjectHandler({
    projects: dependencies.projects,
  }) as unknown as CommandHandler<unknown, unknown>,
  makeCloseProjectHandler({
    projects: dependencies.projects,
    executions: dependencies.executions,
    responseJobs: dependencies.responseJobs,
    inbox: dependencies.inbox,
  }) as unknown as CommandHandler<unknown, unknown>,
];

export const P1CommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  ProjectRepository | WorkspaceRepository | SessionRepository | WorkRepository
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const projectResourceProfiles = yield* Effect.serviceOption(
      ProjectResourceProfilePort,
    );
    const clock = yield* Effect.serviceOption(Clock);
    const handlers = makeP1CommandHandlers({
      ...(Option.isSome(clock) ? { clock: clock.value } : {}),
      projects,
      workspaces,
      sessions,
      works,
      ...(Option.isSome(projectResourceProfiles)
        ? { projectResourceProfiles: projectResourceProfiles.value }
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

/** P12 `01` §5 + `02` §5: the Project-tool registration and permission
 * governance commands. Kept as a separate factory so the frozen P1 registry
 * dependency set is unchanged (registration is wired where the P12 plane
 * composes). */
export interface P12CommandDependencies {
  readonly projectToolRegistry: ProjectToolRegistryService;
  /** P12 `02` §5 (CI-1): when provided, the `GrantPermission` /
   * `RevokePermission` handlers are registered; they are the only durable
   * writers of the grant store. */
  readonly permissionGrantRepository?: PermissionGrantRepositoryService;
}

export const makeP12CommandHandlers = (
  dependencies: P12CommandDependencies,
): ReadonlyArray<CommandHandler<unknown, unknown>> => {
  const handlers: Array<CommandHandler<unknown, unknown>> = [
    makeRegisterProjectToolHandler({
      registry: dependencies.projectToolRegistry,
    }) as unknown as CommandHandler<unknown, unknown>,
  ];
  if (dependencies.permissionGrantRepository !== undefined) {
    const grants = dependencies.permissionGrantRepository;
    handlers.push(
      makeGrantPermissionHandler({ grants }) as unknown as CommandHandler<
        unknown,
        unknown
      >,
      makeRevokePermissionHandler({ grants }) as unknown as CommandHandler<
        unknown,
        unknown
      >,
    );
  }
  return handlers;
};
