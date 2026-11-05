import { type SessionId, type WorkspaceId, workEpisode } from "@arbor/domain";
import {
  ExecutionRepository,
  type ExecutionRepositoryError,
  InboxProjectionStore,
  type InboxProjectionStoreError,
  type LeaseFencingRejected,
  type SessionEpochConflict,
  SessionRepository,
  type SessionRepositoryError,
  type SessionSourceConflict,
  type SessionWriteFence,
  sessionCausalBindingForWork,
  sha256Hex,
  type TransactionOperationalFailure,
  TransactionPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export interface PromoteInboxInput {
  readonly workspaceId: WorkspaceId;
  readonly entryKey: string;
  readonly targetSessionId: SessionId;
  readonly delivery: "Steer" | "Queue";
  readonly fence: SessionWriteFence;
}

export type InputPromotionError =
  | InboxProjectionStoreError
  | SessionRepositoryError
  | LeaseFencingRejected
  | SessionSourceConflict
  | SessionEpochConflict
  | TransactionOperationalFailure
  | ExecutionRepositoryError
  | {
      readonly _tag: "InboxEntryNotFound";
      readonly workspaceId: WorkspaceId;
      readonly entryKey: string;
    }
  | {
      readonly _tag: "InputPromotionTargetMismatch";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
    };

export interface InputPromotionServiceShape {
  readonly promoteInbox: (
    input: PromoteInboxInput,
  ) => Effect.Effect<
    { readonly sequence: number; readonly inserted: boolean },
    InputPromotionError
  >;
}

export interface InputPromotionQualificationProbeEvent {
  readonly boundary:
    | "AH15BeforeInboxPromotionCommit"
    | "AH15AfterInboxPromotionCommit";
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly entryKey: string;
}

export type InputPromotionQualificationProbe = (
  event: InputPromotionQualificationProbeEvent,
) => Promise<void>;

export class InputPromotionService extends Context.Service<
  InputPromotionService,
  InputPromotionServiceShape
>()("arbor/InputPromotionService") {}

const makeInputPromotionServiceLive = (
  qualificationProbe?: InputPromotionQualificationProbe,
): Layer.Layer<
  InputPromotionService,
  never,
  | TransactionPort
  | SessionRepository
  | InboxProjectionStore
  | ExecutionRepository
> =>
  Layer.effect(
    InputPromotionService,
    Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      const inbox = yield* InboxProjectionStore;
      const executions = yield* ExecutionRepository;
      return InputPromotionService.of({
        promoteInbox: (input) =>
          Effect.gen(function* () {
            const event = {
              executionId: input.fence.executionId,
              workspaceId: input.workspaceId,
              sessionId: input.targetSessionId,
              entryKey: input.entryKey,
            };
            const receipt = yield* tx.transact(
              Effect.gen(function* () {
                const entry = yield* inbox.findByKey(
                  input.workspaceId,
                  input.entryKey,
                );
                if (Option.isNone(entry)) {
                  return yield* Effect.fail({
                    _tag: "InboxEntryNotFound" as const,
                    workspaceId: input.workspaceId,
                    entryKey: input.entryKey,
                  });
                }
                const session = yield* sessions.findById(input.targetSessionId);
                if (
                  Option.isNone(session) ||
                  session.value.binding._tag !== "WorkspacePrimary" ||
                  session.value.binding.workspaceId !== input.workspaceId
                ) {
                  return yield* Effect.fail({
                    _tag: "InputPromotionTargetMismatch" as const,
                    workspaceId: input.workspaceId,
                    sessionId: input.targetSessionId,
                  });
                }
                const execution = yield* executions.findById(
                  input.fence.executionId,
                );
                const executionValue = Option.isSome(execution)
                  ? execution.value
                  : undefined;
                const episode =
                  executionValue === undefined
                    ? null
                    : workEpisode(executionValue);
                const item = {
                  _tag: "UserMessage" as const,
                  source: {
                    _tag: "InboxEntry" as const,
                    workspaceId: input.workspaceId,
                    entryKey: entry.value.entryKey,
                    kind: entry.value.kind,
                  },
                  contentRef: `inbox:${entry.value.entryKey}`,
                  text: entry.value.summary,
                  trust: "DataOnly" as const,
                  delivery: input.delivery,
                };
                const receipt = yield* sessions.appendItemIdempotent(
                  input.targetSessionId,
                  {
                    item,
                    contextEpoch: session.value.contextEpoch,
                    source: { kind: "InboxEntry", ref: entry.value.entryKey },
                    contentHash: sha256Hex(JSON.stringify(item)),
                    ...(episode === null || executionValue === undefined
                      ? {}
                      : {
                          causalBinding: sessionCausalBindingForWork({
                            projectId: executionValue.projectId,
                            workspaceId: input.workspaceId,
                            workId: episode.workId,
                            executionId: input.fence.executionId,
                            causedByRef: `inbox:${entry.value.entryKey}`,
                          }),
                        }),
                  },
                  input.fence,
                );
                yield* inbox.markConsumed(input.workspaceId, input.entryKey);
                if (qualificationProbe !== undefined) {
                  yield* Effect.promise(() =>
                    qualificationProbe({
                      boundary: "AH15BeforeInboxPromotionCommit",
                      ...event,
                    }),
                  );
                }
                return receipt;
              }),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH15AfterInboxPromotionCommit",
                  ...event,
                }),
              );
            }
            return receipt;
          }),
      });
    }),
  );

export const InputPromotionServiceLive = makeInputPromotionServiceLive();

/** Explicit process-local qualification seam; production composition leaves
 * this absent. */
export const InputPromotionServiceWithQualificationProbe = (
  qualificationProbe: InputPromotionQualificationProbe,
): Layer.Layer<
  InputPromotionService,
  never,
  | TransactionPort
  | SessionRepository
  | InboxProjectionStore
  | ExecutionRepository
> => makeInputPromotionServiceLive(qualificationProbe);
