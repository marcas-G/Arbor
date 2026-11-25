import type { CommandSubmissionContext, Execution } from "@arbor/domain";
import { workEpisode } from "@arbor/domain";
import type { ControlBasis } from "@arbor/model-context";
import {
  EnvironmentRevisionStore,
  type EnvironmentRevisionStoreService,
  type ExecutionDriverError,
  ProjectRepository,
  type ProjectRepositoryService,
  sha256Hex,
  TransactionPort,
  type TransactionPortService,
  WorkRepository,
  type WorkRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import { toExecutionDriverError } from "./execution-driver-failure.js";

export interface ControlBasisResolverDependencies {
  readonly tx: TransactionPortService;
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly environmentRevisions: EnvironmentRevisionStoreService;
  readonly failure: (cause: unknown) => ExecutionDriverError;
}

export const makeControlBasisResolver = (
  dependencies: ControlBasisResolverDependencies,
  input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  },
): (() => Effect.Effect<ControlBasis, ExecutionDriverError>) => {
  const { tx, projects, workspaces, works, environmentRevisions, failure } =
    dependencies;
  return () =>
    tx
      .transact(
        Effect.gen(function* () {
          const project = yield* projects.findById(input.execution.projectId);
          const workspace = yield* workspaces.findById(
            input.execution.workspaceId,
          );
          if (Option.isNone(project) || Option.isNone(workspace)) {
            return yield* Effect.fail({
              _tag: "ControlBasisSourceMissing" as const,
              projectId: input.execution.projectId,
              workspaceId: input.execution.workspaceId,
            });
          }
          const environmentRevision = yield* environmentRevisions.current(
            input.execution.projectId,
          );
          let workBinding:
            | { readonly workId: string; readonly workRevision: number }
            | undefined;
          const boundWork = workEpisode(input.execution);
          if (boundWork !== null) {
            const work = yield* works.findById(boundWork.workId);
            if (Option.isNone(work)) {
              return yield* Effect.fail({
                _tag: "ControlBasisWorkMissing" as const,
                workId: boundWork.workId,
              });
            }
            workBinding = {
              workId: String(work.value.workId),
              workRevision: Number(work.value.revision),
            };
          }
          const revisions = {
            projectPolicyRevision: Number(project.value.projectPolicyRevision),
            workspacePolicyRevision: Number(
              workspace.value.workspacePolicyRevision,
            ),
            responsibilityRevision: Number(
              workspace.value.responsibilityRevision,
            ),
            resourceBoundaryRevision: Number(
              workspace.value.resourceBoundaryRevision,
            ),
            ...(workBinding === undefined ? {} : workBinding),
            environmentRevision: Option.getOrElse(
              environmentRevision,
              () => "0",
            ),
          };
          return {
            ...revisions,
            authorizationDigest: sha256Hex(
              JSON.stringify({
                principal: input.context.principal,
                executionId: input.execution.executionId,
                projectId: input.execution.projectId,
                workspaceId: input.execution.workspaceId,
                revisions,
              }),
            ),
          } satisfies ControlBasis;
        }),
      )
      .pipe(Effect.mapError(failure));
};

// E03 (architecture-evolution object 1): the assembly of the trusted
// control-basis resolver out of four repositories used to live inline in
// the driver's per-drive body — the orchestrator knowing exactly which
// stores back the capability. It is now a capability Service: the Live
// layer owns the assembly, the driver consumes the capability.
export class ControlBasisResolver extends Context.Service<
  ControlBasisResolver,
  (input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  }) => () => Effect.Effect<ControlBasis, ExecutionDriverError>
>()("arbor/ControlBasisResolver") {}

export const ControlBasisResolverLive: Layer.Layer<
  ControlBasisResolver,
  never,
  | TransactionPort
  | ProjectRepository
  | WorkspaceRepository
  | WorkRepository
  | EnvironmentRevisionStore
> = Layer.effect(
  ControlBasisResolver,
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const environmentRevisions = yield* EnvironmentRevisionStore;
    const failure = toExecutionDriverError;
    return ControlBasisResolver.of((input) =>
      makeControlBasisResolver(
        { tx, projects, workspaces, works, environmentRevisions, failure },
        input,
      ),
    );
  }),
);
