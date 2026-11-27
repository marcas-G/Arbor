import type {
  AgentActionError,
  AgentActionHandler,
} from "@arbor/agent-runtime";
import {
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  decodeRegisteredCommandReceipt,
  deliverMessagePlan,
  makeSendMessageHandler,
  newUuid7,
  submitDeliver,
} from "@arbor/application";
import {
  CommandId,
  type CommandId as CommandIdType,
  type LeaseGeneration,
  MessageId as MessageIdSchema,
  messageEntryKey,
  parse,
} from "@arbor/domain";
import {
  type ClockService,
  type CommandStoreService,
  type DeliverableRepositoryService,
  type DeliverReplayFailureCode,
  type DomainEventJournalService,
  IdGenerator,
  type IdGeneratorService,
  type InboxProjectionStoreService,
  type MessageStoreService,
  type RecoveryAttentionFactStoreService,
  sha256Hex,
  type TransactionPortService,
  type WorkRepositoryService,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  actionError,
  actionOperationalFailure,
  generationScopedCommandId,
  isFencingRejectedReceipt,
} from "./command-receipts.js";

export interface DeliverActionDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<
    CommandStoreService,
    "findResolution" | "hasRetryableAttempt"
  >;
  readonly deliverables: DeliverableRepositoryService;
  readonly works: WorkRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly messages: MessageStoreService;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert"> &
    Partial<Pick<InboxProjectionStoreService, "findByKey">>;
  readonly journal: DomainEventJournalService;
  readonly replayAttention?: Pick<
    RecoveryAttentionFactStoreService,
    "recordDeliverReplayFailure" | "findDeliverReplayFailure"
  >;
  /** Test-only process-crash seam. Production composition must omit it. */
  readonly deliverReplayQualificationProbe?: DeliverReplayQualificationProbe;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly ids: IdGeneratorService;
}

export interface DeliverReplayQualificationEvent {
  readonly boundary:
    | "BeforeDeliverReplayAttentionCommit"
    | "AfterDeliverReplayAttentionCommit";
  readonly executionId: string;
  readonly logicalActionId: string;
  readonly messageId: string;
  readonly failureCode: DeliverReplayFailureCode;
}

export type DeliverReplayQualificationProbe = (
  event: DeliverReplayQualificationEvent,
) => Promise<void>;

const isRecord = (
  value: unknown,
  key?: string,
  expected?: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    key === undefined ||
    (Object.hasOwn(record, key) && record[key] === expected)
  );
};

const exactObject = (
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean => {
  if (!isRecord(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) =>
        key === expectedKeys[index] && actual[key] === expected[key],
    )
  );
};

const exactDeliverMessage = (
  actual: import("@arbor/domain").OutboundMessage,
  expected: {
    readonly recipientWorkspaceId: import("@arbor/domain").WorkspaceId;
    readonly bodyRef: string;
  },
): boolean =>
  actual.kind === "Deliver" &&
  actual.recipientWorkspaceId === expected.recipientWorkspaceId &&
  actual.bodyRef === expected.bodyRef &&
  actual.correlationId === undefined &&
  actual.causationId === undefined &&
  actual.urgency === "Normal";

export const deliverMessageGatewayHandler = (
  dependencies: DeliverActionDependencies,
): AgentActionHandler => ({
  action: "Deliver",
  handle: ({ action, invocation, execution, context, logicalActionId }) =>
    Effect.gen(function* () {
      if (action._tag !== "Deliver") {
        return yield* Effect.fail(
          actionOperationalFailure("Deliver.dispatch")(
            "Deliver handler received a different AgentAction",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const commandId = generationScopedCommandId(
        "deliver-command",
        occurrence,
        context,
      );
      const messageId = parse(MessageIdSchema)(
        `msg_${newUuid7("deliver-message", occurrence)}`,
      );
      const pinnedLogicalActionId = logicalActionId;
      const replayAttention = dependencies.replayAttention;
      if (
        pinnedLogicalActionId === undefined ||
        replayAttention === undefined
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("Deliver.recovery")(
            "Deliver replay failure identity and store are required",
          ),
        );
      }
      const expectedAttentionFactId = `att_${sha256Hex(
        JSON.stringify({
          version: 1,
          executionId: execution.executionId,
          logicalActionId: pinnedLogicalActionId,
          messageId,
        }),
      )}`;
      const priorReplayFailure = yield* dependencies.tx.transact(
        replayAttention.findDeliverReplayFailure(expectedAttentionFactId),
      );
      if (Option.isSome(priorReplayFailure)) {
        const fact = priorReplayFailure.value;
        if (
          fact.attentionFactId !== expectedAttentionFactId ||
          fact.projectId !== execution.projectId ||
          fact.executionId !== execution.executionId ||
          fact.targetWorkspaceId !== execution.workspaceId ||
          fact.logicalActionId !== pinnedLogicalActionId ||
          fact.messageId !== messageId
        ) {
          return yield* Effect.fail(
            actionOperationalFailure("Deliver.recovery")(
              "stored Deliver replay failure has conflicting identity",
            ),
          );
        }
        return yield* Effect.fail<AgentActionError>({
          _tag: "AgentActionRecoveryBlocked",
          executionId: execution.executionId,
          logicalActionId: pinnedLogicalActionId,
        });
      }
      const sender = yield* dependencies.tx.transact(
        dependencies.workspaces.findById(execution.workspaceId),
      );
      const deliverable = yield* dependencies.tx.transact(
        dependencies.deliverables.findById(action.deliverableId),
      );
      let deliverableSourceIsExact = false;
      if (Option.isSome(deliverable)) {
        const sourceWork = yield* dependencies.tx.transact(
          dependencies.works.findById(deliverable.value.sourceWorkId),
        );
        deliverableSourceIsExact =
          Option.isSome(sourceWork) &&
          sourceWork.value.projectId === execution.projectId &&
          sourceWork.value.workspaceId === execution.workspaceId;
      }
      let expectedRecipientWorkspaceId:
        | import("@arbor/domain").WorkspaceId
        | null = null;
      if (
        Option.isSome(sender) &&
        sender.value.projectId === execution.projectId &&
        sender.value.parentWorkspaceId !== null
      ) {
        expectedRecipientWorkspaceId = sender.value.parentWorkspaceId;
      }
      const planFor = (candidateCommandId: CommandIdType) =>
        deliverMessagePlan({
          messageId,
          commandId: candidateCommandId,
          projectId: execution.projectId,
          senderWorkspaceId: execution.workspaceId,
          deliverableId: action.deliverableId,
          bodyRef: action.summary,
          principal: context.principal,
          actor: context.principal as never,
        });
      const failure = (safeMessage: string): AgentActionError =>
        actionOperationalFailure("Deliver.recovery")(safeMessage);
      const block = (
        failureCode: DeliverReplayFailureCode,
        causedByCommandId?: CommandIdType,
      ) =>
        Effect.gen(function* () {
          const factInput = {
            projectId: execution.projectId,
            executionId: execution.executionId,
            targetWorkspaceId: execution.workspaceId,
            logicalActionId: pinnedLogicalActionId,
            messageId,
            failureCode,
            firstDetectedAt: yield* dependencies.clock.now(),
            ...(causedByCommandId === undefined ? {} : { causedByCommandId }),
          };
          yield* dependencies.tx.transact(
            Effect.gen(function* () {
              yield* replayAttention.recordDeliverReplayFailure(factInput);
              yield* Effect.promise(
                () =>
                  dependencies.deliverReplayQualificationProbe?.({
                    boundary: "BeforeDeliverReplayAttentionCommit",
                    executionId: execution.executionId,
                    logicalActionId: pinnedLogicalActionId,
                    messageId,
                    failureCode,
                  }) ?? Promise.resolve(),
              );
            }),
          );
          yield* Effect.promise(
            () =>
              dependencies.deliverReplayQualificationProbe?.({
                boundary: "AfterDeliverReplayAttentionCommit",
                executionId: execution.executionId,
                logicalActionId: pinnedLogicalActionId,
                messageId,
                failureCode,
              }) ?? Promise.resolve(),
          );
          return yield* Effect.fail<AgentActionError>({
            _tag: "AgentActionRecoveryBlocked",
            executionId: execution.executionId,
            logicalActionId: pinnedLogicalActionId,
          });
        });

      const findInboxByKey = dependencies.inbox.findByKey;
      if (findInboxByKey === undefined) {
        return yield* Effect.fail(
          failure("Deliver Inbox evidence lookup is unavailable"),
        );
      }

      const readEffects = () =>
        Effect.gen(function* () {
          const message = yield* dependencies.messages.findById(messageId);
          const inbox = yield* findInboxByKey(
            expectedRecipientWorkspaceId ?? execution.workspaceId,
            messageEntryKey(messageId),
          );
          const matchingEvents: Array<
            import("@arbor/domain").DomainEvent<unknown>
          > = [];
          let cursor = 0;
          for (;;) {
            const batch = yield* dependencies.journal.readAfter(
              execution.projectId,
              cursor,
              512,
            );
            for (const event of batch) {
              if (
                event.eventType !== "MessageSent" ||
                (event.aggregateRef !== messageId &&
                  !isRecord(event.payload, "messageId", messageId))
              ) {
                continue;
              }
              matchingEvents.push(event);
            }
            if (batch.length < 512) break;
            const last = batch[batch.length - 1];
            if (last === undefined || Number(last.sequence) <= cursor) {
              return yield* Effect.fail(
                failure("MessageSent journal scan did not advance"),
              );
            }
            cursor = Number(last.sequence);
          }
          return { message, inbox, events: matchingEvents };
        });

      const effects = yield* dependencies.tx.transact(readEffects());
      const hasEffect =
        Option.isSome(effects.message) ||
        Option.isSome(effects.inbox) ||
        effects.events.length > 0;
      const eventPayload = {
        messageId,
        kind: "Deliver",
        sender: execution.workspaceId,
        recipient: expectedRecipientWorkspaceId,
        deliverableId: action.deliverableId,
        correlationId: null,
        causationId: null,
      };
      const exactRecord =
        Option.isSome(effects.message) &&
        expectedRecipientWorkspaceId !== null &&
        effects.message.value.messageId === messageId &&
        effects.message.value.senderWorkspaceId === execution.workspaceId &&
        effects.message.value.sentAt !== "" &&
        exactDeliverMessage(effects.message.value.message, {
          recipientWorkspaceId: expectedRecipientWorkspaceId,
          bodyRef: action.summary,
        });
      const messageRecord = Option.isSome(effects.message)
        ? effects.message.value
        : undefined;
      const inboxMatchesIfPresent = (admittedAt: string) =>
        Option.isNone(effects.inbox) ||
        (effects.inbox.value.recipientWorkspaceId ===
          expectedRecipientWorkspaceId &&
          effects.inbox.value.entryKey === messageEntryKey(messageId) &&
          effects.inbox.value.kind === "Message" &&
          effects.inbox.value.summary ===
            `Deliver ${action.deliverableId} from ${execution.workspaceId}` &&
          effects.inbox.value.correlationId === undefined &&
          effects.inbox.value.admittedAt === admittedAt);
      const eventMatches = (cause: CommandIdType) => {
        if (effects.events.length !== 1 || !exactRecord) return false;
        const event = effects.events[0];
        return (
          event !== undefined &&
          event.projectId === execution.projectId &&
          event.aggregateRef === messageId &&
          event.eventType === "MessageSent" &&
          event.eventVersion === 1 &&
          event.causedByCommandId === cause &&
          messageRecord !== undefined &&
          event.occurredAt === messageRecord.sentAt &&
          exactObject(event.payload, eventPayload)
        );
      };
      const recoverableContext =
        context._tag === "ExecutionOrigin" ? context : undefined;
      let chosenCommandId = commandId;
      let committedReceipt:
        | (Omit<
            import("@arbor/domain").CommandReceipt<
              import("@arbor/application").DeliverMessageResult,
              unknown
            >,
            "resolution"
          > & {
            readonly resolution: Extract<
              import("@arbor/domain").CommandReceipt<
                import("@arbor/application").DeliverMessageResult,
                unknown
              >["resolution"],
              { readonly _tag: "Committed" }
            >;
          })
        | undefined;
      let rejectedReceipt:
        | import("@arbor/domain").CommandReceipt<unknown, unknown>
        | undefined;
      let fencingRejectedCommandId: CommandIdType | undefined;
      let retryableCommandId: CommandIdType | undefined;
      if (recoverableContext !== undefined) {
        if (
          dependencies.commandReceipts === undefined ||
          dependencies.commandHandlerRegistry === undefined
        ) {
          return yield* Effect.fail(
            failure("Deliver receipt recovery dependencies are unavailable"),
          );
        }
        const handler =
          dependencies.commandHandlerRegistry.lookup("DeliverMessage");
        if (
          Option.isNone(handler) ||
          handler.value.commandType !== "DeliverMessage"
        ) {
          return yield* Effect.fail(
            failure("DeliverMessage receipt decoder is not registered"),
          );
        }
        for (
          let priorGeneration = 0;
          priorGeneration <= recoverableContext.fencingGeneration;
          priorGeneration += 1
        ) {
          const candidateCommandId = generationScopedCommandId(
            "deliver-command",
            occurrence,
            {
              ...recoverableContext,
              fencingGeneration: priorGeneration as LeaseGeneration,
            },
          );
          const raw = yield* dependencies.tx.transact(
            dependencies.commandReceipts.findResolution(candidateCommandId),
          );
          if (Option.isNone(raw)) {
            if (
              priorGeneration < recoverableContext.fencingGeneration &&
              dependencies.commandReceipts.hasRetryableAttempt === undefined
            ) {
              return yield* Effect.fail(
                failure(
                  "Deliver retry-attempt lookup is required for cross-generation recovery",
                ),
              );
            }
            if (
              dependencies.commandReceipts.hasRetryableAttempt !== undefined &&
              (yield* dependencies.tx.transact(
                dependencies.commandReceipts.hasRetryableAttempt(
                  candidateCommandId,
                ),
              )) &&
              retryableCommandId === undefined
            ) {
              retryableCommandId = candidateCommandId;
            }
            continue;
          }
          if (
            raw.value.commandId !== candidateCommandId ||
            raw.value.projectId !== execution.projectId ||
            raw.value.fingerprintAlgorithmVersion !== 1
          ) {
            return yield* block(
              "PriorReceiptResultMismatch",
              candidateCommandId,
            );
          }
          if (raw.value.schemaVersion !== handler.value.schemaVersion) {
            return yield* block(
              "PriorReceiptDecodeMismatch",
              candidateCommandId,
            );
          }
          const decoded = yield* decodeRegisteredCommandReceipt<
            import("@arbor/application").DeliverMessageResult
          >(raw.value, "DeliverMessage", handler.value.schemaVersion).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (decoded === null) {
            return yield* block(
              "PriorReceiptDecodeMismatch",
              candidateCommandId,
            );
          }
          // A Committed receipt from the current generation is the immutable
          // request for this same CommandId, so its fingerprint must still
          // match. A prior-generation receipt is a receipt-first handoff: its
          // fingerprint binds the old request and is not compared to the
          // current generation's candidate request. Its CommandId, trusted
          // schema, result, and canonical effects remain verified below.
          if (
            priorGeneration === recoverableContext.fencingGeneration &&
            decoded.semanticRequestFingerprint !==
              planFor(candidateCommandId).authority.semanticRequestFingerprint
          ) {
            return yield* block(
              "PriorReceiptResultMismatch",
              candidateCommandId,
            );
          }
          if (decoded.resolution._tag === "Committed") {
            committedReceipt = decoded as typeof committedReceipt;
            chosenCommandId = candidateCommandId;
            break;
          }
          if (isFencingRejectedReceipt(decoded.resolution)) {
            fencingRejectedCommandId = candidateCommandId;
            continue;
          }
          rejectedReceipt = decoded;
          chosenCommandId = candidateCommandId;
          break;
        }
      }

      if (committedReceipt !== undefined) {
        const result = committedReceipt.resolution.result;
        if (
          expectedRecipientWorkspaceId === null ||
          result.messageId !== messageId ||
          result.deliverableId !== action.deliverableId ||
          result.senderWorkspaceId !== execution.workspaceId ||
          result.recipientWorkspaceId !== expectedRecipientWorkspaceId ||
          result.admitted !== true ||
          !exactRecord ||
          !deliverableSourceIsExact ||
          !eventMatches(chosenCommandId) ||
          !inboxMatchesIfPresent(effects.events[0]?.occurredAt ?? "")
        ) {
          return yield* block("PriorReceiptResultMismatch", chosenCommandId);
        }
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `DeliverableDelivered(${action.deliverableId}, ${expectedRecipientWorkspaceId})`,
            truncated: false,
          },
        };
      }

      if (rejectedReceipt !== undefined) {
        if (hasEffect) {
          return yield* block("PriorReceiptEffectConflict", chosenCommandId);
        }
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `DeliverMessage rejected: ${JSON.stringify(rejectedReceipt.resolution)}`,
            truncated: false,
          },
        };
      }

      if (fencingRejectedCommandId !== undefined && hasEffect) {
        return yield* block(
          "RejectedReceiptEffectConflict",
          fencingRejectedCommandId,
        );
      }
      if (retryableCommandId !== undefined && hasEffect) {
        return yield* block("PriorReceiptEffectConflict", retryableCommandId);
      }

      if (
        hasEffect &&
        recoverableContext !== undefined &&
        recoverableContext.fencingGeneration > 0
      ) {
        return yield* block("PriorReceiptEffectConflict");
      }

      if (committedReceipt === undefined && rejectedReceipt === undefined) {
        const legacyCommandId = parse(CommandId)(
          `cmd_${newUuid7("deliver-command", occurrence)}`,
        );
        if (hasEffect) {
          const legacyProof =
            exactRecord &&
            deliverableSourceIsExact &&
            eventMatches(legacyCommandId);
          if (
            Option.isSome(effects.inbox) &&
            (!legacyProof ||
              !inboxMatchesIfPresent(effects.events[0]?.occurredAt ?? ""))
          ) {
            return yield* block("LegacyInboxConflict");
          }
          if (effects.events.length === 0 && Option.isSome(effects.message)) {
            return yield* block("LegacyMessageMissingEvent");
          }
          if (Option.isNone(effects.message) && effects.events.length > 0) {
            return yield* block("LegacyEventMissingMessage");
          }
          if (!legacyProof) {
            return yield* block("LegacyMessageBindingMismatch");
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `DeliverableDelivered(${action.deliverableId}, ${expectedRecipientWorkspaceId})`,
              truncated: false,
            },
          };
        }
        if (retryableCommandId !== undefined)
          chosenCommandId = retryableCommandId;
      }
      const plan = deliverMessagePlan({
        messageId,
        commandId: chosenCommandId,
        projectId: execution.projectId,
        senderWorkspaceId: execution.workspaceId,
        deliverableId: action.deliverableId,
        bodyRef: action.summary,
        principal: context.principal,
        actor: context.principal as never,
      });
      const receipt = yield* dependencies.gateway.execute<
        import("@arbor/application").DeliverMessagePayload,
        import("@arbor/application").DeliverMessageResult
      >(
        {
          commandType: "DeliverMessage",
          commandId: chosenCommandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload: plan.payload,
        },
        context,
        plan.authority,
      );
      if (receipt.resolution._tag !== "Committed") {
        const reason =
          receipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(receipt.resolution.error)
            : "operational DeliverMessage failure";
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `DeliverMessage rejected: ${reason}`,
            truncated: false,
          },
        };
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DeliverableDelivered(${action.deliverableId}, ${receipt.resolution.result.recipientWorkspaceId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("Deliver"))),
});

/** Historical direct-write handler retained only so the pending AH10
 * regression fixture can continue to reproduce the pre-Gateway bypass. The
 * production action registry below uses deliverMessageGatewayHandler. */
export const deliverHandler = (
  dependencies: Omit<DeliverActionDependencies, "gateway">,
): AgentActionHandler => ({
  action: "Deliver",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "Deliver") {
        return yield* Effect.fail(
          actionOperationalFailure("Deliver.dispatch")(
            "Deliver handler received a different AgentAction",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const commandId = parse(CommandId)(
        `cmd_${newUuid7("deliver-command", occurrence)}`,
      );
      const messageId = parse(MessageIdSchema)(
        `msg_${newUuid7("deliver-message", occurrence)}`,
      );
      const sendMessage = makeSendMessageHandler({
        workspaces: dependencies.workspaces,
        messages: dependencies.messages,
        inbox: dependencies.inbox,
      });
      const submission = yield* dependencies.tx.transact(
        submitDeliver(
          {
            senderWorkspaceId: execution.workspaceId,
            deliverableId: action.deliverableId,
            bodyRef: action.summary,
            commandId,
            messageId,
            projectId: execution.projectId,
            actor: context.principal as never,
            principal: context.principal,
          },
          {
            deliverables: dependencies.deliverables,
            works: dependencies.works,
            workspaces: dependencies.workspaces,
            sendMessage,
            inbox: dependencies.inbox,
            journal: dependencies.journal,
            clock: dependencies.clock,
          },
        ).pipe(Effect.provideService(IdGenerator, dependencies.ids)),
      );
      if (submission._tag === "Rejected") {
        return yield* Effect.fail(
          actionError(
            JSON.stringify(submission.rejection),
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DeliverableDelivered(${action.deliverableId}, ${submission.outcome.recipientWorkspaceId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("Deliver"))),
});
