import type {
  Actor,
  CommandId,
  CommandReceipt,
  CommandResolution,
  CommandSubmissionContext,
  ProjectId,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import {
  Clock,
  CommandStore,
  type CommandStoreError,
  DomainEventJournal,
  type DomainEventJournalError,
  IdGenerator,
  type PendingDomainEvent,
  type ProjectRepositoryError,
  type SessionRepositoryError,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionScope,
  type WorkRepositoryError,
  type WorkspaceRepositoryError,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import {
  type CommandAuthorityRule,
  type VerifiedCommandAuthority,
  validateCommandAuthority,
} from "./authority.js";
import type { CommandResult } from "./command-result.js";
import {
  FINGERPRINT_ALGORITHM_VERSION,
  semanticRequestFingerprint,
} from "./fingerprint.js";
import type { CommandRejection } from "./rejection.js";

export interface GatewayEnvelope<C> {
  readonly commandType: string;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly causationRef?: string;
  readonly correlationRef?: string;
  readonly payload: C;
}

export interface CommandOutcome<R> {
  readonly result: R;
  readonly events: ReadonlyArray<PendingDomainEvent>;
}

export type CommandHandlerError =
  | ProjectRepositoryError
  | WorkspaceRepositoryError
  | WorkRepositoryError
  | SessionRepositoryError
  | CommandStoreError
  | DomainEventJournalError;

export interface CommandHandler<C, R> {
  readonly commandType: string;
  readonly schemaVersion: string;
  readonly authority: CommandAuthorityRule<C>;
  readonly execute: (
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
  ) => Effect.Effect<
    CommandResult<CommandOutcome<R>>,
    CommandHandlerError,
    TransactionScope
  >;
}

export interface CommandHandlerRegistryService {
  readonly lookup: (
    commandType: string,
  ) => Option.Option<CommandHandler<unknown, unknown>>;
}

export class CommandHandlerRegistry extends Context.Service<
  CommandHandlerRegistry,
  CommandHandlerRegistryService
>()("arbor/CommandHandlerRegistry") {}

export const CommandHandlerRegistryLive = (
  handlers: ReadonlyArray<CommandHandler<unknown, unknown>>,
): Layer.Layer<CommandHandlerRegistry> =>
  Layer.succeed(CommandHandlerRegistry, {
    lookup: (commandType) => {
      const handler = handlers.find(
        (candidate) => candidate.commandType === commandType,
      );
      return handler === undefined ? Option.none() : Option.some(handler);
    },
  });

export type FenceStopOutcome = "Pass" | "FencingRejected" | "ExecutionStopping";

export interface FenceStopCheckService {
  readonly check: (
    context: CommandSubmissionContext,
  ) => Effect.Effect<FenceStopOutcome>;
}

export class FenceStopCheck extends Context.Service<
  FenceStopCheck,
  FenceStopCheckService
>()("arbor/FenceStopCheck") {}

export const FenceStopCheckInertLive: Layer.Layer<FenceStopCheck> =
  Layer.succeed(FenceStopCheck, {
    check: () => Effect.succeed("Pass"),
  });

export type CommandGatewayError =
  | CommandHandlerError
  | TransactionOperationalFailure;

export interface CommandGatewayService {
  readonly execute: <C, R>(
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
    authority: VerifiedCommandAuthority,
  ) => Effect.Effect<CommandReceipt<R, CommandRejection>, CommandGatewayError>;
}

export class CommandGateway extends Context.Service<
  CommandGateway,
  CommandGatewayService
>()("arbor/CommandGateway") {}

const decodeReceipt = <R>(
  stored: CommandReceipt<unknown, unknown>,
): CommandReceipt<R, CommandRejection> => ({
  ...stored,
  resolution:
    stored.resolution._tag === "Committed"
      ? { _tag: "Committed", result: stored.resolution.result as R }
      : {
          _tag: "TerminalRejected",
          error: stored.resolution.error as CommandRejection,
        },
});

const makeReceipt = <R>(
  commandId: CommandId,
  projectId: ProjectId,
  fingerprint: SemanticRequestFingerprint,
  schemaVersion: string,
  resolution: CommandResolution<R, CommandRejection>,
  createdAt: string,
  settledAt: string,
): CommandReceipt<R, CommandRejection> => ({
  commandId,
  projectId,
  semanticRequestFingerprint: fingerprint,
  schemaVersion,
  fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
  resolution,
  createdAt,
  settledAt,
});

export const CommandGatewayLive: Layer.Layer<
  CommandGateway,
  never,
  | TransactionPort
  | CommandStore
  | DomainEventJournal
  | CommandHandlerRegistry
  | FenceStopCheck
  | Clock
  | IdGenerator
> = Layer.effect(
  CommandGateway,
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const store = yield* CommandStore;
    const journal = yield* DomainEventJournal;
    const registry = yield* CommandHandlerRegistry;
    const fence = yield* FenceStopCheck;
    const clock = yield* Clock;
    const idGenerator = yield* IdGenerator;

    const execute = <C, R>(
      envelope: GatewayEnvelope<C>,
      context: CommandSubmissionContext,
      authority: VerifiedCommandAuthority,
    ): Effect.Effect<
      CommandReceipt<R, CommandRejection>,
      CommandGatewayError
    > =>
      Effect.gen(function* () {
        const handlerOption = registry.lookup(envelope.commandType);
        if (Option.isNone(handlerOption)) {
          return yield* Effect.die(
            new Error(`no command handler for ${envelope.commandType}`),
          );
        }
        const handler = handlerOption.value;
        const schemaVersion = handler.schemaVersion;
        const fingerprint = semanticRequestFingerprint({
          commandType: envelope.commandType,
          projectId: envelope.projectId,
          actor: envelope.actor,
          schemaVersion,
          payload: envelope.payload,
        });
        const startedAt = yield* clock.now();

        const body = Effect.gen(function* () {
          const existing = yield* store.findResolution(envelope.commandId);
          if (Option.isSome(existing)) {
            const stored = existing.value;
            if (
              stored.semanticRequestFingerprint === fingerprint &&
              stored.schemaVersion === schemaVersion &&
              stored.fingerprintAlgorithmVersion ===
                FINGERPRINT_ALGORITHM_VERSION
            ) {
              return decodeReceipt<R>(stored);
            }
            return {
              ...stored,
              semanticRequestFingerprint: fingerprint,
              resolution: {
                _tag: "TerminalRejected" as const,
                error: {
                  _tag: "IdempotencyConflict" as const,
                  commandId: envelope.commandId,
                } satisfies CommandRejection,
              },
            } satisfies CommandReceipt<R, CommandRejection>;
          }

          if (context._tag === "ExecutionOrigin") {
            const outcome = yield* fence.check(context);
            if (outcome !== "Pass") {
              const rejection: CommandRejection = { _tag: outcome };
              const settledAt = yield* clock.now();
              yield* store.insertTerminalRejected(
                envelope.commandId,
                envelope.projectId,
                fingerprint,
                schemaVersion,
                FINGERPRINT_ALGORITHM_VERSION,
                JSON.stringify(rejection),
              );
              yield* store.recordResolvingAttempt(
                envelope.commandId,
                "TerminalRejected",
                startedAt,
                settledAt,
              );
              return makeReceipt<R>(
                envelope.commandId,
                envelope.projectId,
                fingerprint,
                schemaVersion,
                { _tag: "TerminalRejected", error: rejection },
                startedAt,
                settledAt,
              );
            }
          }

          const authorityMismatch = validateCommandAuthority(
            authority,
            handler.authority,
            {
              principal: context.principal,
              commandId: envelope.commandId,
              projectId: envelope.projectId,
              semanticRequestFingerprint: fingerprint,
              payload: envelope.payload,
            },
          );
          if (Option.isSome(authorityMismatch)) {
            const rejection: CommandRejection = {
              _tag: "AuthorityDenied",
              reason: authorityMismatch.value,
            };
            const settledAt = yield* clock.now();
            yield* store.insertTerminalRejected(
              envelope.commandId,
              envelope.projectId,
              fingerprint,
              schemaVersion,
              FINGERPRINT_ALGORITHM_VERSION,
              JSON.stringify(rejection),
            );
            yield* store.recordResolvingAttempt(
              envelope.commandId,
              "TerminalRejected",
              startedAt,
              settledAt,
            );
            return makeReceipt<R>(
              envelope.commandId,
              envelope.projectId,
              fingerprint,
              schemaVersion,
              { _tag: "TerminalRejected", error: rejection },
              startedAt,
              settledAt,
            );
          }

          const outcome = yield* handler.execute(envelope, context);
          const settledAt = yield* clock.now();
          if (!outcome.ok) {
            const rejection: CommandRejection = outcome.error;
            yield* store.insertTerminalRejected(
              envelope.commandId,
              envelope.projectId,
              fingerprint,
              schemaVersion,
              FINGERPRINT_ALGORITHM_VERSION,
              JSON.stringify(rejection),
            );
            yield* store.recordResolvingAttempt(
              envelope.commandId,
              "TerminalRejected",
              startedAt,
              settledAt,
            );
            return makeReceipt<R>(
              envelope.commandId,
              envelope.projectId,
              fingerprint,
              schemaVersion,
              { _tag: "TerminalRejected", error: rejection },
              startedAt,
              settledAt,
            );
          }
          if (outcome.value.events.length > 0) {
            yield* journal.append(outcome.value.events);
          }
          yield* store.insertCommitted(
            envelope.commandId,
            envelope.projectId,
            fingerprint,
            schemaVersion,
            FINGERPRINT_ALGORITHM_VERSION,
            JSON.stringify(outcome.value.result),
          );
          yield* store.recordResolvingAttempt(
            envelope.commandId,
            "Committed",
            startedAt,
            settledAt,
          );
          return makeReceipt<R>(
            envelope.commandId,
            envelope.projectId,
            fingerprint,
            schemaVersion,
            { _tag: "Committed", result: outcome.value.result as R },
            startedAt,
            settledAt,
          );
        });

        return yield* tx.transact(body).pipe(
          Effect.catchTag("TransactionOperationalFailure", (failure) =>
            Effect.gen(function* () {
              const settledAt = yield* clock.now();
              yield* tx
                .transact(
                  store.recordRetryableAttempt(
                    envelope.commandId,
                    "TransactionOperationalFailure",
                    startedAt,
                    settledAt,
                  ),
                )
                .pipe(Effect.orDie);
              return yield* Effect.fail(failure);
            }),
          ),
        );
      }).pipe(Effect.provideService(IdGenerator, idGenerator));

    return CommandGateway.of({ execute });
  }),
);
