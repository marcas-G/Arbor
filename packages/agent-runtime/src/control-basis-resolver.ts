import type { CommandSubmissionContext, Execution } from "@arbor/domain";
import type { ControlBasis } from "@arbor/model-context";
import type {
  EnvironmentRevisionStoreService,
  ExecutionDriverError,
  ProjectRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";

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
          if (
            input.execution.binding._tag === "WorkspaceExecution" &&
            input.execution.binding.focus._tag === "Work"
          ) {
            const work = yield* works.findById(
              input.execution.binding.focus.workId,
            );
            if (Option.isNone(work)) {
              return yield* Effect.fail({
                _tag: "ControlBasisWorkMissing" as const,
                workId: input.execution.binding.focus.workId,
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
