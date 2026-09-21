import type {
  Actor,
  CommandId,
  DeliverableId,
  MessageId,
  OutboundMessage,
  Principal,
  ProjectId,
  WakeReason,
  WorkspaceId,
} from "@arbor/domain";
import { messageEntryKey } from "@arbor/domain";
import type {
  ClockService,
  DeliverableRepositoryService,
  DomainEventJournalService,
  IdGenerator,
  InboxProjectionStoreService,
  PendingDomainEvent,
  TransactionScope,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type {
  CommandHandler,
  CommandHandlerError,
  GatewayEnvelope,
} from "../gateway.js";
import type { CommandRejection } from "../rejection.js";
import type { SendMessagePayload, SendMessageResult } from "./send-message.js";

/** P6 `02` §2 (inherited by P7 `02` §3): bodyRef is a bounded view, capped by
 * the frozen sender upload quota. */
const MAX_BODY_REF_LENGTH = 4096;

/** P7 `02` §3. The Deliver message payload: an OutboundMessage whose kind is
 * "Deliver" plus the deliverableId reference (required iff kind = Deliver).
 * The domain OutboundMessage keeps the P6 frozen shape; the Deliverable
 * reference rides as the §3 discriminated field on this narrow type. */
export interface DeliverMessage extends OutboundMessage {
  readonly kind: "Deliver";
  readonly deliverableId: DeliverableId;
}

/** P7 `02` §8 / §4. Caller-preallocated ids (DID G5); recipient is derived
 * (sender's direct parent), never model-chosen. */
export interface SubmitDeliverArgs {
  readonly senderWorkspaceId: WorkspaceId;
  readonly deliverableId: DeliverableId;
  readonly bodyRef: string;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly principal: Principal;
}

export interface DeliverDependencies {
  readonly deliverables: Pick<DeliverableRepositoryService, "findById">;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly sendMessage: CommandHandler<SendMessagePayload, SendMessageResult>;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
  readonly journal: Pick<DomainEventJournalService, "append">;
  readonly clock: Pick<ClockService, "now">;
}

/** P7 `02` §6 (06 §2 delivery-record pattern). The ChildDelivered wake signal
 * is produced at the delivery boundary and carried in the Result; the consumer
 * (coordinator / P7-011) reads it after the transaction commits. */
export interface DeliverWakeSignal {
  readonly workspaceId: WorkspaceId;
  readonly reason: Extract<WakeReason, { readonly _tag: "ChildDelivered" }>;
  readonly detail: {
    readonly deliverableId: DeliverableId;
    readonly messageId: MessageId;
  };
}

export interface DeliverOutcome {
  readonly messageId: MessageId;
  readonly deliverableId: DeliverableId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly recipientWorkspaceId: WorkspaceId;
  readonly promotion: {
    readonly closesCorrelation: string | null;
    readonly triggersReevaluation: boolean;
  };
  readonly wakeSignal: DeliverWakeSignal;
}

/** Typed submission result: Deliver rejections are values (directive-visible
 * observations, P7 `02` §8), never throws. Operational store failures stay in
 * the E channel. */
export type DeliverSubmission =
  | { readonly _tag: "Delivered"; readonly outcome: DeliverOutcome }
  | { readonly _tag: "Rejected"; readonly rejection: CommandRejection };

const rejected = (rejection: CommandRejection): DeliverSubmission => ({
  _tag: "Rejected",
  rejection,
});

/** P7 `02` §3–§7. Command-level Deliver: SendMessage kind=Deliver with the
 * Deliver-specific preconditions (references-never-creates; frozen child →
 * direct-parent direction, resolved canonically) composed AROUND the frozen
 * SendMessage handler — send-message.ts is untouched. One transaction:
 * MessageStore append + MessageSent + Inbox admission ("Message", no enum
 * expansion, summary referencing the deliverable) + the ChildDelivered wake
 * signal carried in the Result. Promotion for Deliver is empty — Deliver
 * never satisfies a Dependency. */
export const submitDeliver = (
  args: SubmitDeliverArgs,
  dependencies: DeliverDependencies,
): Effect.Effect<
  DeliverSubmission,
  CommandHandlerError,
  TransactionScope | IdGenerator
> =>
  Effect.gen(function* () {
    // §3: deliverableId references, never creates. Read failures are
    // operational (SqlError) — defect, matching the P7 store convention.
    const stored = yield* dependencies.deliverables
      .findById(args.deliverableId)
      .pipe(Effect.orDie);
    if (Option.isNone(stored)) {
      return rejected({
        _tag: "DeliverableNotFound",
        deliverableId: args.deliverableId,
      });
    }

    // §4 direction (frozen): sender must be the Workspace owning
    // deliverable.sourceWorkId — resolved canonically, never model-asserted.
    const work = yield* dependencies.works.findById(stored.value.sourceWorkId);
    if (Option.isNone(work)) {
      return rejected({
        _tag: "AuthorityDenied",
        reason: "deliverable source work not found",
      });
    }
    if (work.value.projectId !== args.projectId) {
      return rejected({
        _tag: "AuthorityDenied",
        reason: "source work belongs to another project",
      });
    }
    if (work.value.workspaceId !== args.senderWorkspaceId) {
      return rejected({
        _tag: "AuthorityDenied",
        reason:
          "sender must be the workspace owning the deliverable's source work",
      });
    }

    // §4: recipient is derived = the sender's direct parent.
    const sender = yield* dependencies.workspaces.findById(
      args.senderWorkspaceId,
    );
    if (Option.isNone(sender)) {
      return rejected({
        _tag: "AuthorityDenied",
        reason: "sender workspace not found",
      });
    }
    const recipientWorkspaceId = sender.value.parentWorkspaceId;
    if (recipientWorkspaceId === null) {
      return rejected({
        _tag: "AuthorityDenied",
        reason: "root has no parent to deliver to",
      });
    }
    const recipient =
      yield* dependencies.workspaces.findById(recipientWorkspaceId);
    if (Option.isNone(recipient)) {
      return rejected({
        _tag: "WorkspaceNotFound",
        workspaceId: recipientWorkspaceId,
      });
    }
    if (recipient.value.projectId !== args.projectId) {
      return rejected({
        _tag: "AuthorityDenied",
        reason: "recipient belongs to another project",
      });
    }
    if (recipient.value.lifecycle !== "Active") {
      return rejected({
        _tag: "TerminalLifecycleMutation",
        entity: "Workspace",
        lifecycle: recipient.value.lifecycle,
      });
    }

    if (
      args.bodyRef.length === 0 ||
      args.bodyRef.length > MAX_BODY_REF_LENGTH
    ) {
      return rejected({
        _tag: "ResourceExhausted",
        reason: `bodyRef must be 1..${MAX_BODY_REF_LENGTH} chars (got ${args.bodyRef.length})`,
      });
    }

    const issuedAt = yield* dependencies.clock.now();
    const message: DeliverMessage = {
      kind: "Deliver",
      recipientWorkspaceId,
      deliverableId: args.deliverableId,
      bodyRef: args.bodyRef,
      correlationId: args.correlationId,
      causationId: args.causationId,
      urgency: "Normal",
    };

    // §5: Inbox admission stays upsert-by-key in InboxEntry.kind "Message".
    // The summary must reference the deliverable, so the Deliver-specific
    // admission lands FIRST; the SendMessage handler's generic admission of
    // the same entryKey is then a no-op (upsert-by-key, D3).
    yield* dependencies.inbox.admitUpsert({
      recipientWorkspaceId,
      entryKey: messageEntryKey(args.messageId),
      kind: "Message",
      summary: `Deliver ${args.deliverableId} from ${args.senderWorkspaceId}`,
      correlationId: args.correlationId,
      admittedAt: issuedAt,
    });

    // All SendMessage-inherited preconditions are covered above, so the
    // frozen handler executes the durable part: MessageStore append,
    // MessageSent draft, Inbox admission (no-op here), empty Deliver
    // promotion.
    const envelope: GatewayEnvelope<SendMessagePayload> = {
      commandType: "SendMessage",
      commandId: args.commandId,
      projectId: args.projectId,
      actor: args.actor,
      issuedAt,
      payload: {
        messageId: args.messageId,
        senderWorkspaceId: args.senderWorkspaceId,
        message,
      },
    };
    const sent = yield* dependencies.sendMessage.execute(envelope, {
      _tag: "External",
      principal: args.principal,
    });
    if (!sent.ok) {
      return rejected(sent.error);
    }

    // §4 event shape: MessageSent carries the deliverableId reference.
    const events: ReadonlyArray<PendingDomainEvent> = sent.value.events.map(
      (event) =>
        event.eventType === "MessageSent"
          ? {
              ...event,
              payload: {
                ...(event.payload as Record<string, unknown>),
                deliverableId: args.deliverableId,
              },
            }
          : event,
    );
    if (events.length > 0) {
      yield* dependencies.journal.append(events);
    }

    return {
      _tag: "Delivered",
      outcome: {
        messageId: args.messageId,
        deliverableId: args.deliverableId,
        senderWorkspaceId: args.senderWorkspaceId,
        recipientWorkspaceId,
        promotion: sent.value.result.promotion,
        wakeSignal: {
          workspaceId: recipientWorkspaceId,
          reason: { _tag: "ChildDelivered" },
          detail: {
            deliverableId: args.deliverableId,
            messageId: args.messageId,
          },
        },
      },
    };
  });
