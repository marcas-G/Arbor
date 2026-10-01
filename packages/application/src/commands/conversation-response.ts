import type { MessageId } from "@arbor/domain";
import type {
  ConversationResponseJobStoreService,
  PendingDomainEvent,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export interface ResumeConversationResponsePayload {
  readonly messageId: MessageId;
  readonly expectedJobRevision: number;
}

export interface CancelConversationResponsePayload {
  readonly messageId: MessageId;
  readonly expectedJobRevision: number;
}

export interface ConversationResponseCommandResult {
  readonly messageId: MessageId;
  readonly state: "Queued" | "Cancelled";
  readonly revision: number;
}

export interface ConversationResponseCommandDependencies {
  readonly jobs: Pick<
    ConversationResponseJobStoreService,
    "find" | "transition"
  >;
}

export const makeResumeConversationResponseHandler = (
  dependencies: ConversationResponseCommandDependencies,
): CommandHandler<
  ResumeConversationResponsePayload,
  ConversationResponseCommandResult
> => ({
  commandType: "ResumeConversationResponse",
  schemaVersion: "1",
  authority: {
    tag: "ConversationResponseAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "ConversationResponseAuthority" &&
      authority.commandKind === "ResumeConversationResponse" &&
      authority.messageId === payload.messageId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const found = yield* dependencies.jobs.find(envelope.payload.messageId);
      if (Option.isNone(found)) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "conversation response job not found",
        });
      }
      const job = found.value;
      if (job.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "conversation response belongs to another project",
        });
      }
      if (job.revision !== envelope.payload.expectedJobRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: envelope.payload.expectedJobRevision,
          actual: job.revision,
        });
      }
      if (job.state._tag !== "NeedsAttention") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "ConversationResponseJob",
          lifecycle: job.state._tag,
        });
      }
      const next = yield* dependencies.jobs
        .transition({
          messageId: job.messageId,
          expectedRevision: job.revision,
          expectedState: "NeedsAttention",
          next: {
            ...job,
            state: { _tag: "Queued" },
            lastFailureClass: null,
            revision: job.revision + 1,
            updatedAt: envelope.issuedAt,
          },
        })
        .pipe(
          Effect.catchTag("ConversationJobConflict", (conflict) =>
            Effect.fail({
              _tag: "ConversationJobStoreError" as const,
              cause: conflict,
            }),
          ),
        );
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ConversationResponseResumed",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: job.messageId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: { messageId: job.messageId, revision: next.revision },
        },
      ];
      return commandOk({
        result: {
          messageId: job.messageId,
          state: "Queued",
          revision: next.revision,
        },
        events,
      });
    }),
});

export const makeCancelConversationResponseHandler = (
  dependencies: ConversationResponseCommandDependencies,
): CommandHandler<
  CancelConversationResponsePayload,
  ConversationResponseCommandResult
> => ({
  commandType: "CancelConversationResponse",
  schemaVersion: "1",
  authority: {
    tag: "ConversationResponseAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "ConversationResponseAuthority" &&
      authority.commandKind === "CancelConversationResponse" &&
      authority.messageId === payload.messageId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const found = yield* dependencies.jobs.find(envelope.payload.messageId);
      if (Option.isNone(found)) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "conversation response job not found",
        });
      }
      const job = found.value;
      if (job.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "conversation response belongs to another project",
        });
      }
      if (job.revision !== envelope.payload.expectedJobRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: envelope.payload.expectedJobRevision,
          actual: job.revision,
        });
      }
      if (job.state._tag === "Running") {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "running response must be stopped through StopExecution",
        });
      }
      if (job.state._tag === "Answered" || job.state._tag === "Cancelled") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "ConversationResponseJob",
          lifecycle: job.state._tag,
        });
      }
      const next = yield* dependencies.jobs
        .transition({
          messageId: job.messageId,
          expectedRevision: job.revision,
          expectedState: job.state._tag,
          next: {
            ...job,
            state: { _tag: "Cancelled", reason: "HumanCancelled" },
            revision: job.revision + 1,
            updatedAt: envelope.issuedAt,
          },
        })
        .pipe(
          Effect.catchTag("ConversationJobConflict", (conflict) =>
            Effect.fail({
              _tag: "ConversationJobStoreError" as const,
              cause: conflict,
            }),
          ),
        );
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ConversationResponseCancelled",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: job.messageId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: { messageId: job.messageId, revision: next.revision },
        },
      ];
      return commandOk({
        result: {
          messageId: job.messageId,
          state: "Cancelled",
          revision: next.revision,
        },
        events,
      });
    }),
});
