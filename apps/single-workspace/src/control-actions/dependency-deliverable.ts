import type { AgentActionHandler } from "@arbor/agent-runtime";
import {
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  type DeclareDependencyPayload,
  type DeclareDependencyResult,
  decodeRegisteredCommandReceipt,
  FINGERPRINT_ALGORITHM_VERSION,
  newUuid7,
  type ProduceDeliverablePayload,
  type ProduceDeliverableResult,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  type ArtifactRole,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  parse,
  workEpisode,
} from "@arbor/domain";
import type {
  ClockService,
  CommandStoreService,
  DependencyRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { AnyProducerEvidenceRequest } from "../any-producer-evidence.js";
import {
  actionError,
  actionOperationalFailure,
  findPriorCommandReceipt,
  generationScopedCommandId,
} from "./command-receipts.js";

export interface DeclareDependencyDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<CommandStoreService, "findResolution">;
  readonly dependencyRecords?: Pick<DependencyRepositoryService, "findById">;
  readonly works: WorkRepositoryService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly anyProducerEvidence?: (
    request: AnyProducerEvidenceRequest,
  ) => Effect.Effect<boolean, unknown>;
}

export interface ProduceDeliverableDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts: Pick<CommandStoreService, "findResolution">;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
}

/** ACR-8 (DID v1.19): P7 dependency lifecycle is frozen. The handler
 * submits DeclareDependency through the gateway with a synthesized
 * DeclareDependencyAuthority (P7 §2 fact projection binds targetWorkspaceId
 * to the workspace owning consumerWorkId). dependencyId and
 * expectedConsumerWorkRevision are trusted Runtime facts — the current
 * Work revision is read from the store, never model-supplied; declaring
 * never asserts satisfaction (the matcher alone decides). */
export const declareDependencyHandler = (
  dependencies: DeclareDependencyDependencies,
): AgentActionHandler => ({
  action: "DeclareDependency",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "DeclareDependency") {
        return yield* Effect.fail(
          actionOperationalFailure("DeclareDependency.dispatch")(
            "DeclareDependency handler received a different AgentAction",
          ),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "DeclareDependency requires an active Work binding as the consumer",
          ),
        );
      }
      const workId = boundWork.workId;
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const dependencyId = parse(DependencyId)(
        `dep_${newUuid7("declare-dependency", occurrence)}`,
      );
      if (context._tag === "ExecutionOrigin" && context.fencingGeneration > 0) {
        const dependencyRecords = dependencies.dependencyRecords;
        if (dependencyRecords === undefined) {
          return yield* Effect.fail(
            actionOperationalFailure("DeclareDependency.receiptLookup")(
              "receipt and canonical Dependency lookup are required for generation takeover",
            ),
          );
        }
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "declare-dependency-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "DeclareDependency",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "DeclareDependency.priorReceipt",
          errorOperation: "DeclareDependency",
          lookupOperation: "DeclareDependency.receiptLookup",
        });
        if (prior._tag === "Committed") {
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("dependencyId" in result) ||
            result.dependencyId !== dependencyId ||
            !("consumerWorkId" in result) ||
            result.consumerWorkId !== workId ||
            !("state" in result) ||
            result.state !== "Unsatisfied" ||
            !("revision" in result) ||
            result.revision !== 0
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("DeclareDependency.priorReceipt")(
                "prior Committed result does not match the pinned action",
              ),
            );
          }
          const dependency = yield* dependencies.tx.transact(
            dependencyRecords.findById(dependencyId),
          );
          const consumerWork = yield* dependencies.tx.transact(
            dependencies.works.findById(workId),
          );
          const expectedRoles = [
            ...action.expectedDeliverable.requiredArtifactRoles,
          ].sort();
          if (
            Option.isNone(dependency) ||
            Option.isNone(consumerWork) ||
            consumerWork.value.projectId !== execution.projectId ||
            dependency.value.dependencyId !== dependencyId ||
            dependency.value.consumerWorkId !== workId ||
            dependency.value.producerBinding._tag !==
              action.producerBinding._tag ||
            (action.producerBinding._tag === "WorkspaceBound" &&
              dependency.value.producerBinding._tag === "WorkspaceBound" &&
              dependency.value.producerBinding.workspaceId !==
                action.producerBinding.workspaceId) ||
            (action.producerBinding._tag === "WorkBound" &&
              dependency.value.producerBinding._tag === "WorkBound" &&
              dependency.value.producerBinding.workId !==
                action.producerBinding.workId) ||
            dependency.value.expectedDeliverable.kind !==
              action.expectedDeliverable.kind ||
            JSON.stringify(
              [
                ...dependency.value.expectedDeliverable.requiredArtifactRoles,
              ].sort(),
            ) !== JSON.stringify(expectedRoles)
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("DeclareDependency.priorReceipt")(
                "Committed receipt has no exact matching canonical Dependency row",
              ),
            );
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `DependencyDeclared(${dependencyId}, Unsatisfied)`,
              truncated: false,
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `DeclareDependency rejected: ${JSON.stringify(prior.receipt.resolution.error)}`,
              truncated: false,
            },
          };
        }
      }
      const work = yield* dependencies.tx.transact(
        dependencies.works.findById(workId),
      );
      if (Option.isNone(work)) {
        return yield* Effect.fail(actionError("consuming Work is missing"));
      }
      const payload = {
        dependencyId,
        consumerWorkId: workId,
        producerBinding: action.producerBinding,
        expectedDeliverable: {
          kind: action.expectedDeliverable.kind as DeliverableKind,
          requiredArtifactRoles: action.expectedDeliverable
            .requiredArtifactRoles as ArtifactRole[],
        },
        expectedConsumerWorkRevision: work.value.revision,
        revision: parse(DependencyRevision)(0),
      };
      const commandId = generationScopedCommandId(
        "declare-dependency-command",
        occurrence,
        context,
      );
      if (action.producerBinding._tag === "AnyProducer") {
        if (context._tag === "ExecutionOrigin") {
          if (
            dependencies.commandReceipts === undefined ||
            dependencies.commandHandlerRegistry === undefined
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("DeclareDependency.currentReceipt")(
                "receipt lookup and registered decoder are required for AnyProducer admission",
              ),
            );
          }
          const exact = yield* dependencies.tx.transact(
            dependencies.commandReceipts.findResolution(commandId),
          );
          if (Option.isSome(exact)) {
            const registered =
              dependencies.commandHandlerRegistry.lookup("DeclareDependency");
            if (
              Option.isNone(registered) ||
              registered.value.commandType !== "DeclareDependency" ||
              (exact.value.schemaVersion !== registered.value.schemaVersion &&
                !(registered.value.priorReceiptSchemaVersions ?? []).includes(
                  exact.value.schemaVersion,
                ))
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("DeclareDependency.currentReceipt")(
                  "current Command receipt schema is not registered",
                ),
              );
            }
            const expectedFingerprint = semanticRequestFingerprint({
              commandType: "DeclareDependency",
              projectId: execution.projectId,
              actor: context.principal as never,
              schemaVersion: exact.value.schemaVersion,
              payload,
            });
            const decoded = yield* decodeRegisteredCommandReceipt<unknown>(
              exact.value,
              "DeclareDependency",
              exact.value.schemaVersion,
            );
            if (
              exact.value.commandId !== commandId ||
              exact.value.projectId !== execution.projectId ||
              exact.value.fingerprintAlgorithmVersion !==
                FINGERPRINT_ALGORITHM_VERSION ||
              exact.value.semanticRequestFingerprint !== expectedFingerprint
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("DeclareDependency.currentReceipt")(
                  "current Command receipt does not bind the exact action",
                ),
              );
            }
            if (decoded.resolution._tag === "TerminalRejected") {
              return {
                _tag: "Observation" as const,
                source: "Runtime" as const,
                observation: {
                  text: `DeclareDependency rejected: ${JSON.stringify(decoded.resolution.error)}`,
                  truncated: false,
                },
              };
            }
            const result = decoded.resolution.result as {
              readonly dependencyId?: unknown;
              readonly consumerWorkId?: unknown;
              readonly state?: unknown;
              readonly revision?: unknown;
            };
            if (
              result.dependencyId !== dependencyId ||
              result.consumerWorkId !== workId ||
              result.state !== "Unsatisfied" ||
              result.revision !== 0
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("DeclareDependency.currentReceipt")(
                  "current Committed result does not match the pinned action",
                ),
              );
            }
            if (dependencies.dependencyRecords === undefined) {
              return yield* Effect.fail(
                actionOperationalFailure("DeclareDependency.currentReceipt")(
                  "canonical Dependency lookup is required to replay a Committed receipt",
                ),
              );
            }
            const [canonicalDependency, canonicalConsumer] = yield* Effect.all(
              [
                dependencies.tx.transact(
                  dependencies.dependencyRecords.findById(dependencyId),
                ),
                dependencies.tx.transact(dependencies.works.findById(workId)),
              ],
              { concurrency: 1 },
            );
            const expectedRoles = [
              ...action.expectedDeliverable.requiredArtifactRoles,
            ].sort();
            if (
              Option.isNone(canonicalDependency) ||
              Option.isNone(canonicalConsumer) ||
              canonicalConsumer.value.projectId !== execution.projectId ||
              canonicalDependency.value.dependencyId !== dependencyId ||
              canonicalDependency.value.consumerWorkId !== workId ||
              canonicalDependency.value.producerBinding._tag !==
                action.producerBinding._tag ||
              canonicalDependency.value.expectedDeliverable.kind !==
                action.expectedDeliverable.kind ||
              JSON.stringify(
                [
                  ...canonicalDependency.value.expectedDeliverable
                    .requiredArtifactRoles,
                ].sort(),
              ) !== JSON.stringify(expectedRoles)
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("DeclareDependency.currentReceipt")(
                  "Committed receipt has no exact matching canonical Dependency",
                ),
              );
            }
            return {
              _tag: "Observation" as const,
              source: "Runtime" as const,
              observation: {
                text: `DependencyDeclared(${dependencyId}, Unsatisfied)`,
                truncated: false,
              },
            };
          }
        }
        if (dependencies.anyProducerEvidence === undefined) {
          return yield* Effect.fail(
            actionOperationalFailure("DeclareDependency.evidence")(
              "AnyProducer evidence reader is unavailable",
            ),
          );
        }
        const hasEvidence = yield* dependencies.anyProducerEvidence({
          projectId: execution.projectId,
          consumerWorkId: workId,
          expectedDeliverable: action.expectedDeliverable,
        });
        if (!hasEvidence) {
          return yield* Effect.fail(
            actionError(
              "No eligible producer evidence exists for this AnyProducer dependency yet.",
            ),
          );
        }
      }
      const receipt = yield* dependencies.gateway.execute<
        DeclareDependencyPayload,
        DeclareDependencyResult
      >(
        {
          commandType: "DeclareDependency",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "DeclareDependencyAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "DeclareDependency",
            projectId: execution.projectId,
            actor: context.principal as never,
            schemaVersion: "1",
            payload: payload as unknown,
          }),
          projectId: execution.projectId,
          targetWorkspaceId: execution.workspaceId,
          consumerWorkId: workId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        const reason =
          receipt.resolution._tag === "TerminalRejected"
            ? JSON.stringify(receipt.resolution.error)
            : "operational DeclareDependency failure";
        return {
          _tag: "Observation" as const,
          source: "Runtime" as const,
          observation: {
            text: `DeclareDependency rejected: ${reason}`,
            truncated: false,
          },
        };
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DependencyDeclared(${receipt.resolution.result.dependencyId}, Unsatisfied)`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("DeclareDependency"))),
});

export const produceDeliverableHandler = (
  dependencies: ProduceDeliverableDependencies,
): AgentActionHandler => ({
  action: "ProduceDeliverable",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "ProduceDeliverable") {
        return yield* Effect.fail(
          actionOperationalFailure("ProduceDeliverable.dispatch")(
            "ProduceDeliverable handler received a different AgentAction",
          ),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "produce_deliverable requires an exact WorkEpisode",
            "action/not-applicable",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const payload: ProduceDeliverablePayload = {
        deliverableId: parse(DeliverableId)(
          `del_${newUuid7("produce-deliverable", occurrence)}`,
        ),
        sourceWorkId: boundWork.workId,
        observedSourceWorkRevision: boundWork.targetWorkRevision,
        kind: action.kind as DeliverableKind,
        artifacts: action.artifacts.map((artifact) => ({
          role: artifact.role as ArtifactRole,
          artifactId: artifact.artifactId,
        })),
      };
      if (context._tag === "ExecutionOrigin" && context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "produce-deliverable-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "ProduceDeliverable",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "ProduceDeliverable.priorReceipt",
          errorOperation: "ProduceDeliverable",
          identityErrorMessage:
            "prior Command receipt belongs to another Project",
        });
        if (prior._tag === "Committed") {
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("deliverableId" in result) ||
            result.deliverableId !== payload.deliverableId ||
            !("sourceWorkId" in result) ||
            result.sourceWorkId !== payload.sourceWorkId ||
            !("sourceWorkRevision" in result) ||
            result.sourceWorkRevision !== payload.observedSourceWorkRevision ||
            !("kind" in result) ||
            result.kind !== payload.kind ||
            !("artifactRoles" in result) ||
            !Array.isArray(result.artifactRoles) ||
            JSON.stringify([...result.artifactRoles].sort()) !==
              JSON.stringify(payload.artifacts.map((item) => item.role).sort())
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("ProduceDeliverable.priorReceipt")(
                "prior Committed result does not match the pinned action",
              ),
            );
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `DeliverableProduced(${payload.deliverableId}, ${action.kind})`,
              truncated: false,
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return yield* Effect.fail(
            actionError(
              "earlier command was terminally rejected",
              "action/canonical-rejected",
              "WaitForStateChange",
            ),
          );
        }
      }
      const commandId = generationScopedCommandId(
        "produce-deliverable-command",
        occurrence,
        context,
      );
      const actor = context.principal as never;
      const receipt = yield* dependencies.gateway.execute<
        ProduceDeliverablePayload,
        ProduceDeliverableResult
      >(
        {
          commandType: "ProduceDeliverable",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "ProduceDeliverableAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "ProduceDeliverable",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          sourceWorkspaceId: execution.workspaceId,
          sourceWorkId: boundWork.workId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "ProduceDeliverable failed operationally",
            "action/canonical-rejected",
            "RetryWithChangedInput",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `DeliverableProduced(${payload.deliverableId}, ${action.kind})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ProduceDeliverable"))),
});
