import type {
  CommandSubmissionContext,
  MessageId,
  Principal,
  ProjectId,
} from "@arbor/domain";
import { Actor, CommandId, ExecutionId, parse } from "@arbor/domain";
import type {
  ClockService,
  ConversationAttemptConflict,
  ConversationAttemptStoreError,
  ConversationAttemptStoreService,
  ConversationJobConflict,
  ConversationJobStoreError,
  ConversationResponseJob,
  ConversationResponseJobStoreService,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  HumanMessageStoreError,
  HumanMessageStoreService,
  ProjectRepositoryError,
  ProjectRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { CommandAuthorityFact } from "./authority.js";
import { semanticRequestFingerprint } from "./fingerprint.js";
import { newUuid7 } from "./formation-plan.js";
import type { CommandGatewayError, CommandGatewayService } from "./gateway.js";

interface AdmitWorkspaceMainPayload {
  readonly _tag: "WorkspaceMain";
  readonly executionId: ExecutionId;
  readonly workspaceId: never;
  readonly focus: { readonly _tag: "Coordination" };
}

const executionIdOf = (messageId: MessageId, attemptNo: number): ExecutionId =>
  parse(ExecutionId)(
    `exe_${newUuid7("p14-conversation", `${messageId}:${String(attemptNo)}`)}`,
  );

const commandIdOf = (messageId: MessageId, attemptNo: number): CommandId =>
  parse(CommandId)(
    `cmd_${newUuid7("p14-conversation-admit", `${messageId}:${String(attemptNo)}`)}`,
  );

export interface ConversationResponseTriggerDependencies {
  readonly gateway: CommandGatewayService;
  readonly jobs: Pick<
    ConversationResponseJobStoreService,
    "listEligible" | "transition"
  >;
  readonly attempts: Pick<ConversationAttemptStoreService, "insert">;
  /** Transitional P14 compatibility; removed when transcript/model history
   * read exclusively from ResponseJob in P17-005. */
  readonly legacyMessages?: Pick<HumanMessageStoreService, "claim">;
  readonly projects: Pick<ProjectRepositoryService, "findById">;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findActiveMainByWorkspace"
  >;
  readonly clock: Pick<ClockService, "now">;
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly principal: Principal;
}

export type ConversationResponseRuntimeError =
  | CommandGatewayError
  | ConversationAttemptConflict
  | ConversationJobConflict
  | ConversationJobStoreError
  | ConversationAttemptStoreError
  | ExecutionRepositoryError
  | ProjectRepositoryError
  | HumanMessageStoreError;

export const runConversationResponseTrigger = (
  dependencies: ConversationResponseTriggerDependencies,
  projectId: ProjectId,
): Effect.Effect<ReadonlyArray<string>, ConversationResponseRuntimeError> =>
  Effect.gen(function* () {
    const now = yield* dependencies.clock.now();
    const eligible = (yield* dependencies.tx.transact(
      dependencies.jobs.listEligible(now),
    )).filter((job) => job.projectId === projectId);
    if (eligible.length === 0) return [];
    const project = yield* dependencies.tx.transact(
      dependencies.projects.findById(projectId),
    );
    if (Option.isNone(project)) return ["skipped:ProjectNotFound"];
    const records: string[] = [];
    if (project.value.lifecycle === "Closed") {
      for (const job of eligible) {
        yield* dependencies.tx.transact(
          dependencies.jobs.transition({
            messageId: job.messageId,
            expectedRevision: job.revision,
            expectedState: job.state._tag,
            next: {
              ...job,
              state: { _tag: "Cancelled", reason: "ProjectClosed" },
              revision: job.revision + 1,
              updatedAt: now,
            },
          }),
        );
        records.push(`cancelled:${job.messageId}`);
      }
      return records;
    }

    const rootWorkspaceId = project.value.rootWorkspaceId;
    const active = yield* dependencies.tx.transact(
      dependencies.executions.findActiveMainByWorkspace(rootWorkspaceId),
    );
    if (Option.isSome(active)) {
      return [`queued:${eligible[0]?.messageId ?? ""}`];
    }
    const job = eligible[0];
    if (job === undefined) return records;
    const attemptNo = job.nextAttemptNo;
    const executionId = executionIdOf(job.messageId, attemptNo);
    const commandId = commandIdOf(job.messageId, attemptNo);
    const payload: AdmitWorkspaceMainPayload = {
      _tag: "WorkspaceMain",
      executionId,
      workspaceId: rootWorkspaceId as never,
      focus: { _tag: "Coordination" },
    };
    const actor = parse(Actor)("system:conversation-trigger");
    const context: CommandSubmissionContext = {
      _tag: "System",
      principal: dependencies.principal,
      causationRef: `p17-conversation-trigger:${job.messageId}`,
    };
    const authority: CommandAuthorityFact = {
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "System",
      principal: dependencies.principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "AdmitExecution",
        projectId,
        actor,
        schemaVersion: "1",
        payload: payload as unknown,
      }),
      projectId,
      commandKind: "AdmitExecution",
      workspaceId: rootWorkspaceId,
      bindingKind: "WorkspaceMain",
    };
    const issuedAt = yield* dependencies.clock.now();
    const receipt = yield* dependencies.gateway.execute(
      {
        commandType: "AdmitExecution",
        commandId,
        projectId,
        actor,
        issuedAt,
        causationRef: job.messageId,
        payload: payload as unknown,
      },
      context,
      authority,
    );
    if (receipt.resolution._tag !== "Committed") {
      return [
        `skipped:${receipt.resolution.error._tag}:${String(job.messageId)}`,
      ];
    }

    yield* dependencies.tx.transact(
      Effect.gen(function* () {
        if (dependencies.legacyMessages !== undefined) {
          yield* dependencies.legacyMessages.claim(job.messageId, executionId);
        }
        yield* dependencies.attempts.insert({
          messageId: job.messageId,
          attemptNo,
          executionId,
          admittedAt: issuedAt,
          settledAt: null,
          settlementKind: null,
          failureClass: null,
          failureFingerprint: null,
          retryDecision: null,
          policyVersion: job.policyVersion,
        });
        yield* dependencies.jobs.transition({
          messageId: job.messageId,
          expectedRevision: job.revision,
          expectedState: job.state._tag,
          next: {
            ...job,
            state: { _tag: "Running", attemptNo, executionId },
            nextAttemptNo: attemptNo + 1,
            revision: job.revision + 1,
            updatedAt: issuedAt,
          },
        });
      }),
    );
    return [`admitted:${executionId}`];
  });

export interface ConversationResponseSweepDependencies {
  readonly jobs: Pick<
    ConversationResponseJobStoreService,
    "listRunning" | "transition"
  >;
  readonly attempts: Pick<ConversationAttemptStoreService, "settle">;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly legacyMessages?: Pick<HumanMessageStoreService, "markAnswered">;
  readonly clock: Pick<ClockService, "now">;
  readonly responseBodyOf: (
    messageId: string,
  ) => Effect.Effect<string | null, never, never>;
}

const attentionJob = (
  job: ConversationResponseJob,
  executionId: ExecutionId,
  reason: "UnknownFailure" | "ReconciliationRequired",
  now: string,
): ConversationResponseJob => ({
  ...job,
  state: {
    _tag: "NeedsAttention",
    reason,
    failureFingerprint: `${reason}:${executionId}`,
    lastExecutionId: executionId,
  },
  lastFailureClass:
    reason === "ReconciliationRequired"
      ? "ReconciliationRequired"
      : "UnknownFailure",
  revision: job.revision + 1,
  updatedAt: now,
});

export const runConversationResponseSettlementSweep = (
  dependencies: ConversationResponseSweepDependencies,
  projectId: ProjectId,
): Effect.Effect<
  ReadonlyArray<string>,
  ConversationResponseRuntimeError,
  import("@arbor/ports").TransactionScope
> =>
  Effect.gen(function* () {
    const records: string[] = [];
    const running = yield* dependencies.jobs.listRunning(projectId);
    for (const job of running) {
      if (job.state._tag !== "Running") continue;
      const executionId = job.state.executionId;
      const execution = yield* dependencies.executions.findById(executionId);
      if (Option.isNone(execution)) {
        const now = yield* dependencies.clock.now();
        const next = attentionJob(job, executionId, "UnknownFailure", now);
        yield* dependencies.attempts.settle({
          messageId: job.messageId,
          attemptNo: job.state.attemptNo,
          settledAt: now,
          settlementKind: "MissingExecution",
          failureClass: "UnknownFailure",
          failureFingerprint: `MissingExecution:${executionId}`,
          retryDecision: { _tag: "Attention", reason: "UnknownFailure" },
        });
        yield* dependencies.jobs.transition({
          messageId: job.messageId,
          expectedRevision: job.revision,
          expectedState: "Running",
          next,
        });
        records.push(`attention:${job.messageId}`);
        continue;
      }
      if (execution.value.state.status === "Active") continue;
      const now = yield* dependencies.clock.now();
      const settlement = execution.value.state.settlement;
      const responseBody =
        settlement._tag === "Completed"
          ? yield* dependencies.responseBodyOf(job.messageId)
          : null;
      const next: ConversationResponseJob =
        settlement._tag === "Completed" && responseBody !== null
          ? {
              ...job,
              state: {
                _tag: "Answered",
                executionId,
                responseBody,
              },
              lastFailureClass: null,
              revision: job.revision + 1,
              updatedAt: now,
            }
          : settlement._tag === "Interrupted"
            ? {
                ...job,
                state: { _tag: "Cancelled", reason: "ControlledStop" },
                lastFailureClass: "ControlledInterruption",
                revision: job.revision + 1,
                updatedAt: now,
              }
            : attentionJob(
                job,
                executionId,
                settlement._tag === "OutcomeUnknown"
                  ? "ReconciliationRequired"
                  : "UnknownFailure",
                now,
              );
      const failureClass =
        next.state._tag === "NeedsAttention"
          ? next.lastFailureClass
          : next.state._tag === "Cancelled"
            ? "ControlledInterruption"
            : null;
      const retryDecision =
        next.state._tag === "Answered"
          ? ({ _tag: "Answer" } as const)
          : next.state._tag === "Cancelled"
            ? ({ _tag: "Cancel", reason: next.state.reason } as const)
            : next.state._tag === "NeedsAttention"
              ? ({ _tag: "Attention", reason: next.state.reason } as const)
              : yield* Effect.die(
                  new Error(
                    `invalid settled response job state ${next.state._tag}`,
                  ),
                );
      yield* dependencies.attempts.settle({
        messageId: job.messageId,
        attemptNo: job.state.attemptNo,
        settledAt: now,
        settlementKind: settlement._tag,
        failureClass,
        failureFingerprint:
          next.state._tag === "NeedsAttention"
            ? next.state.failureFingerprint
            : null,
        retryDecision,
      });
      yield* dependencies.jobs.transition({
        messageId: job.messageId,
        expectedRevision: job.revision,
        expectedState: "Running",
        next,
      });
      if (
        next.state._tag === "Answered" &&
        dependencies.legacyMessages !== undefined
      ) {
        yield* dependencies.legacyMessages.markAnswered(
          job.messageId,
          now,
          next.state.responseBody,
          job.providerReasoning,
        );
      }
      records.push(`${next.state._tag.toLowerCase()}:${job.messageId}`);
    }
    return records;
  });
