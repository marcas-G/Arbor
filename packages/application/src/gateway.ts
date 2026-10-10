import type {
  CommandId,
  CommandReceipt,
  CommandSubmissionContext,
  ExecutionId,
  LeaseGeneration,
  ProjectId,
} from "@arbor/domain";
import {
  Clock,
  CommandStore,
  DomainEventJournal,
  IdGenerator,
  ProjectRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import {
  type CommandAuthorityFact,
  validateCommandAuthority,
} from "./authority.js";
import { CommandHandlerRegistry } from "./command-handler-registry.js";
import { decodeCommandReceipt, makeCommandReceipt } from "./command-receipt.js";
import { CommandInputContractRegistry } from "./external-command-codec.js";
import { FenceStopCheck } from "./fence-stop.js";
import {
  FINGERPRINT_ALGORITHM_VERSION,
  semanticRequestFingerprint,
} from "./fingerprint.js";
import {
  CommandGateway,
  type CommandGatewayError,
  type GatewayEnvelope,
} from "./gateway-contracts.js";
import { projectAdmissionOf } from "./project-admission.js";
import type { CommandRejection } from "./rejection.js";

export * from "./command-handler-registry.js";
export * from "./command-receipt.js";
export * from "./fence-stop.js";
export * from "./gateway-contracts.js";
export * from "./project-admission.js";

/** Process-local crash qualification seam. Product composition leaves it
 * absent; only an explicitly injected test child can pause this transaction. */
export type CommandGatewayQualificationProbe = (event: {
  readonly boundary:
    | "AH10BeforeFencedReceiptCommit"
    | "AH10BeforeAssignWorkBindingCommit"
    | "AH12BeforeSettleExecutionCommit";
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly fencingGeneration: LeaseGeneration;
}) => Promise<void>;

export const makeCommandGatewayLive = (
  qualificationProbe?: CommandGatewayQualificationProbe,
): Layer.Layer<
  CommandGateway,
  never,
  | TransactionPort
  | CommandStore
  | DomainEventJournal
  | CommandHandlerRegistry
  | FenceStopCheck
  | Clock
  | IdGenerator
> =>
  Layer.effect(
    CommandGateway,
    Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const store = yield* CommandStore;
      const journal = yield* DomainEventJournal;
      const registry = yield* CommandHandlerRegistry;
      const fence = yield* FenceStopCheck;
      const projects = yield* Effect.serviceOption(ProjectRepository);
      const clock = yield* Clock;
      const idGenerator = yield* IdGenerator;

      const execute = <C, R>(
        envelope: GatewayEnvelope<C>,
        context: CommandSubmissionContext,
        authority: CommandAuthorityFact,
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

          if (context._tag !== "External") {
            const inputContract = CommandInputContractRegistry.lookup(
              envelope.commandType,
            );
            if (inputContract !== undefined) {
              const validated = inputContract.decodePayload(envelope.payload);
              if (!validated.ok) {
                return yield* Effect.fail({
                  _tag: "InternalCommandContractDefect" as const,
                  commandType: envelope.commandType,
                  issues: validated.issues,
                });
              }
            }
          }

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
                return decodeCommandReceipt<R>(stored);
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
              const outcome = yield* fence.check(
                context,
                handler.stopAdmission,
              );
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
                if (
                  qualificationProbe !== undefined &&
                  outcome === "FencingRejected"
                ) {
                  yield* Effect.promise(() =>
                    qualificationProbe({
                      boundary: "AH10BeforeFencedReceiptCommit",
                      commandId: envelope.commandId,
                      projectId: envelope.projectId,
                      executionId: context.executionId,
                      fencingGeneration: context.fencingGeneration,
                    }),
                  );
                }
                return makeCommandReceipt<R>(
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
                submissionOrigin: context._tag,
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
              return makeCommandReceipt<R>(
                envelope.commandId,
                envelope.projectId,
                fingerprint,
                schemaVersion,
                { _tag: "TerminalRejected", error: rejection },
                startedAt,
                settledAt,
              );
            }

            if (projectAdmissionOf(envelope.commandType) === "OpenRequired") {
              const project = Option.isSome(projects)
                ? yield* projects.value.findById(envelope.projectId)
                : Option.none();
              // The lifecycle gate owns the positive Closed fact. Entity
              // existence remains command-specific (and is backed by canonical
              // foreign keys); this also keeps isolated handler fixtures useful.
              if (
                Option.isSome(project) &&
                project.value.lifecycle !== "Open"
              ) {
                const rejection: CommandRejection = {
                  _tag: "TerminalLifecycleMutation",
                  entity: "Project",
                  lifecycle: project.value.lifecycle,
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
                return makeCommandReceipt<R>(
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
              return makeCommandReceipt<R>(
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
            if (outcome.value.afterReceipt !== undefined) {
              yield* outcome.value.afterReceipt;
            }
            if (
              qualificationProbe !== undefined &&
              envelope.commandType === "AssignWork" &&
              envelope.assignWorkEvidence !== undefined &&
              context._tag === "ExecutionOrigin"
            ) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH10BeforeAssignWorkBindingCommit",
                  commandId: envelope.commandId,
                  projectId: envelope.projectId,
                  executionId: context.executionId,
                  fencingGeneration: context.fencingGeneration,
                }),
              );
            }
            yield* store.recordResolvingAttempt(
              envelope.commandId,
              "Committed",
              startedAt,
              settledAt,
            );
            if (
              qualificationProbe !== undefined &&
              envelope.commandType === "SettleExecution" &&
              context._tag === "ExecutionOrigin"
            ) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH12BeforeSettleExecutionCommit",
                  commandId: envelope.commandId,
                  projectId: envelope.projectId,
                  executionId: context.executionId,
                  fencingGeneration: context.fencingGeneration,
                }),
              );
            }
            return makeCommandReceipt<R>(
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
                  .pipe(Effect.ignore);
                return yield* Effect.fail(failure);
              }),
            ),
            Effect.catchTag("PersistenceUnavailable", (failure) =>
              Effect.gen(function* () {
                if (failure.retryDisposition === "retryable") {
                  const settledAt = yield* clock.now();
                  yield* tx
                    .transact(
                      store.recordRetryableAttempt(
                        envelope.commandId,
                        `PersistenceUnavailable:${failure.repository}:${failure.sourceTag}`,
                        startedAt,
                        settledAt,
                      ),
                    )
                    .pipe(Effect.ignore);
                }
                return yield* Effect.fail(failure);
              }),
            ),
          );
        }).pipe(Effect.provideService(IdGenerator, idGenerator));

      return CommandGateway.of({ execute });
    }),
  );

export const CommandGatewayLive = makeCommandGatewayLive();
