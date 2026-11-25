import type {
  DomainEvent,
  ProjectId,
} from "@arbor/domain";
import {
  type AssignWorkBindingAttentionFact,
  type AttentionProjectionStoreService,
  type ConsumerOffsetStoreError,
  type ProjectionStoreService,
  type RecoveryAttentionFactStoreService,
  type SandboxProviderUnavailableAttentionQueueService,
  type SandboxProviderUnavailableStoreService,
  type ToolObservationReplayAttentionFactStoreService,
  type WorkspaceResourceActivationStoreService,
} from "@arbor/ports";
import {
  Effect,
  Option,
} from "effect";
import { payloadRecord, projectionFailure } from "./consumer-errors.js";


/** Bind the shared P1 ProjectionStore face to one P10 project. `pollOnce`
 * will call `apply` and advance that consumer's offset in its existing single
 * transaction. Reset affects only this project's P10 rows; the P1 generic
 * marker store is not delegated to or cleared. */
export const makeProjectAttentionProjectionStore = (
  projectId: ProjectId,
  sourceFacts: Pick<
    RecoveryAttentionFactStoreService,
    | "findAssignWorkBindingFailure"
    | "findDeliverReplayFailure"
    | "listDeliverReplayFailures"
    | "listPendingDeliverReplayAttention"
    | "acknowledgePendingDeliverReplayAttention"
    | "isSubmittedDecisionBindingAvailable"
    | "findSubmittedDecisionBindingFailure"
    | "listSubmittedDecisionBindingFailures"
    | "findLegacyAdoptionFailure"
    | "findLegacyAdoptionFailureByEventId"
    | "listLegacyAdoptionFailures"
    | "findLegacyAdoptionResolution"
    | "listLegacyAdoptionResolutions"
  >,
  attentionRows: Pick<
    AttentionProjectionStoreService,
    | "putAssignWorkBindingFailure"
    | "putDeliverReplayFailure"
    | "putToolObservationReplayFailure"
    | "isSubmittedDecisionBindingAvailable"
    | "putSubmittedDecisionBindingFailure"
    | "putLegacyAdoptionFailure"
    | "removeLegacyAdoptionFailure"
    | "listLegacyAdoptionFailures"
    | "resetProject"
    | "reconcileWorkspaceResourceActivation"
    | "reconcileStaleWorkRevisionRows"
  >,
  activationIntents?: Pick<WorkspaceResourceActivationStoreService, "listAll">,
  toolObservationFacts?: Pick<
    ToolObservationReplayAttentionFactStoreService,
    "findById"
  >,
  sandboxUnavailableFacts?: Pick<
    SandboxProviderUnavailableStoreService,
    "list"
  >,
  sandboxUnavailableQueue?: Pick<
    SandboxProviderUnavailableAttentionQueueService,
    "rearm"
  >,
): ProjectionStoreService => ({
  apply: (batch: ReadonlyArray<DomainEvent<unknown>>) =>
    Effect.gen(function* () {
      for (const event of batch) {
        if (event.eventType === "WorkSteered") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a WorkSteered event for another project",
            });
          }
          yield* attentionRows
            .reconcileStaleWorkRevisionRows(projectId)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "WorkspaceResourceActivationChanged") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received an activation event for another project",
            });
          }
          if (activationIntents === undefined) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "P10 Activation Attention event has no P1 intent source",
            });
          }
          const eventPayload = payloadRecord(event.payload);
          const revision = eventPayload.resourceBoundaryRevision;
          if (
            eventPayload._tag !== "WorkspaceResourceActivationChanged" ||
            typeof eventPayload.workspaceId !== "string" ||
            event.aggregateRef !== eventPayload.workspaceId ||
            typeof revision !== "number" ||
            !Number.isInteger(revision) ||
            revision < 0 ||
            (eventPayload.status !== "Pending" &&
              eventPayload.status !== "Active")
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "P10 Activation Attention wakeup event was malformed",
            });
          }
          const intents = yield* activationIntents
            .listAll()
            .pipe(Effect.mapError(projectionFailure));
          yield* attentionRows
            .reconcileWorkspaceResourceActivation(projectId, intents)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "DeliverReplayEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a Deliver event for another project",
            });
          }
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "attentionFactId",
            "executionId",
            "failureCode",
            "logicalActionId",
            "messageId",
            "targetWorkspaceId",
          ];
          const attentionFactId = payload.attentionFactId;
          if (
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "Deliver replay event is missing its attentionFactId",
            });
          }
          const found = yield* sourceFacts
            .findDeliverReplayFailure(attentionFactId)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(found)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "Deliver replay event has no matching immutable P9 fact",
            });
          }
          const fact = found.value;
          if (
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            event.eventType !== "DeliverReplayEscalated" ||
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.causedByEventId !== undefined ||
            event.aggregateRef !== fact.targetWorkspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.executionId !== String(payload.executionId ?? "") ||
            fact.targetWorkspaceId !==
              String(payload.targetWorkspaceId ?? "") ||
            fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
            fact.messageId !== String(payload.messageId ?? "") ||
            fact.failureCode !== String(payload.failureCode ?? "") ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Deliver replay event does not exactly match its immutable P9 fact",
            });
          }
          yield* attentionRows
            .putDeliverReplayFailure(fact)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "ToolObservationReplayEvidenceEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a tool observation replay event for another project",
            });
          }
          if (
            toolObservationFacts === undefined ||
            attentionRows.putToolObservationReplayFailure === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 tool observation replay event has no exact P9 fact or P10 marker store",
            });
          }
          const payload = payloadRecord(event.payload);
          const attentionFactId = String(payload.attentionFactId ?? "");
          const found = yield* toolObservationFacts
            .findById(attentionFactId)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(found)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "tool observation replay event has no matching immutable P9 fact",
            });
          }
          const fact = found.value;
          if (
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            event.aggregateRef !== fact.targetWorkspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.causedByCommandId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.attentionFactId !== attentionFactId ||
            fact.executionId !== String(payload.executionId ?? "") ||
            fact.targetWorkspaceId !==
              String(payload.targetWorkspaceId ?? "") ||
            fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
            fact.providerTurnId !== String(payload.providerTurnId ?? "") ||
            fact.callRef !== String(payload.callRef ?? "") ||
            fact.invocationId !== String(payload.invocationId ?? "") ||
            fact.failureCode !== String(payload.failureCode ?? "")
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "tool observation replay event does not exactly match its immutable P9 fact",
            });
          }
          yield* attentionRows
            .putToolObservationReplayFailure(fact, event.occurredAt)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "SubmittedDecisionBindingEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a Submitted Decision event for another project",
            });
          }
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "attentionFactId",
            "executionId",
            "failureCode",
            "logicalActionId",
            "logicalStepNo",
            "providerTurnId",
            "repairAttempt",
            "workspaceId",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findSubmitted = sourceFacts.findSubmittedDecisionBindingFailure;
          const putSubmitted = attentionRows.putSubmittedDecisionBindingFailure;
          if (
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findSubmitted === undefined ||
            putSubmitted === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event has no available immutable P9 fact and P10 marker route",
            });
          }
          const source = yield* findSubmitted(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event has no matching immutable P9 fact",
            });
          }
          const fact = source.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== fact.workspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            fact.attentionFactId !== attentionFactId ||
            fact.executionId !== payload.executionId ||
            fact.workspaceId !== payload.workspaceId ||
            fact.logicalStepNo !== payload.logicalStepNo ||
            fact.repairAttempt !== payload.repairAttempt ||
            fact.providerTurnId !== payload.providerTurnId ||
            fact.logicalActionId !== payload.logicalActionId ||
            fact.failureCode !== payload.failureCode ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event does not exactly match its immutable P9 fact",
            });
          }
          yield* putSubmitted(fact).pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "LegacyAdoptionEvidenceEscalated") {
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "factId",
            "attentionFactId",
            "projectId",
            "executionId",
            "targetWorkspaceId",
            "providerTurnId",
            "logicalStepNo",
            "repairAttempt",
            "failureCode",
            "evidenceSha256",
            "firstDetectedAt",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findLegacy = sourceFacts.findLegacyAdoptionFailure;
          const putLegacy = attentionRows.putLegacyAdoptionFailure;
          if (
            event.projectId !== projectId ||
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findLegacy === undefined ||
            putLegacy === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 failure event has no exact immutable P9 fact and P10 marker route",
            });
          }
          const source = yield* findLegacy(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "AH14 failure event has no matching immutable P9 fact",
            });
          }
          const fact = source.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== fact.executionId ||
            event.correlationRef !== fact.attentionFactId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            fact.executionId !== payload.executionId ||
            fact.workspaceId !== payload.targetWorkspaceId ||
            fact.providerTurnId !== payload.providerTurnId ||
            fact.logicalStepNo !== payload.logicalStepNo ||
            fact.repairAttempt !== payload.repairAttempt ||
            fact.failureCode !== payload.failureCode ||
            fact.evidenceSha256 !== payload.evidenceSha256 ||
            fact.firstDetectedAt !== payload.firstDetectedAt ||
            payload.factId !== fact.attentionFactId ||
            payload.attentionFactId !== fact.attentionFactId ||
            payload.projectId !== fact.projectId ||
            payload.executionId !== fact.executionId ||
            payload.targetWorkspaceId !== fact.workspaceId ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 failure event does not exactly match its immutable P9 fact",
            });
          }
          yield* putLegacy(fact).pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "LegacyAdoptionEvidenceResolved") {
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "factId",
            "attentionFactId",
            "projectId",
            "executionId",
            "targetWorkspaceId",
            "providerTurnId",
            "originalEvidenceSha256",
            "resolutionEvidenceSha256",
            "resolutionCode",
            "resolvedAt",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findLegacy = sourceFacts.findLegacyAdoptionFailure;
          const findResolution = sourceFacts.findLegacyAdoptionResolution;
          const removeLegacy = attentionRows.removeLegacyAdoptionFailure;
          if (
            event.projectId !== projectId ||
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findLegacy === undefined ||
            findResolution === undefined ||
            removeLegacy === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 resolution event has no exact immutable P9 facts and P10 marker route",
            });
          }
          const source = yield* findLegacy(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          const resolved = yield* findResolution(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source) || Option.isNone(resolved)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 resolution event has no matching immutable P9 facts",
            });
          }
          const failureFact = source.value;
          const resolution = resolved.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== failureFact.executionId ||
            event.correlationRef !== failureFact.attentionFactId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== failureFact.eventId ||
            event.occurredAt !== resolution.resolvedAt ||
            resolution.eventId !== event.eventId ||
            resolution.attentionFactId !== failureFact.attentionFactId ||
            resolution.projectId !== projectId ||
            resolution.executionId !== failureFact.executionId ||
            resolution.workspaceId !== failureFact.workspaceId ||
            resolution.providerTurnId !== failureFact.providerTurnId ||
            resolution.originalEvidenceSha256 !== failureFact.evidenceSha256 ||
            payload.factId !== resolution.resolutionFactId ||
            payload.attentionFactId !== failureFact.attentionFactId ||
            payload.projectId !== resolution.projectId ||
            payload.executionId !== resolution.executionId ||
            payload.targetWorkspaceId !== resolution.workspaceId ||
            payload.providerTurnId !== resolution.providerTurnId ||
            payload.originalEvidenceSha256 !==
              resolution.originalEvidenceSha256 ||
            payload.resolutionEvidenceSha256 !==
              resolution.resolutionEvidenceSha256 ||
            payload.resolutionCode !== resolution.resolutionCode ||
            payload.resolvedAt !== resolution.resolvedAt ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 resolution event does not exactly match its immutable P9 facts",
            });
          }
          yield* removeLegacy(failureFact, resolution).pipe(
            Effect.mapError(projectionFailure),
          );
          continue;
        }
        if (event.eventType !== "AssignWorkTargetBindingEscalated") continue;
        if (event.projectId !== projectId) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "P10 Attention consumer received an event for another project",
          });
        }
        const payload = payloadRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        if (attentionFactId.length === 0) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason: "AssignWork binding event is missing its attentionFactId",
          });
        }
        const found = yield* sourceFacts
          .findAssignWorkBindingFailure(attentionFactId)
          .pipe(Effect.mapError(projectionFailure));
        if (Option.isNone(found)) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "AssignWork binding event has no matching immutable P9 fact",
          });
        }
        const fact: AssignWorkBindingAttentionFact = found.value;
        const payloadKeys = Object.keys(payload).sort();
        const expectedPayloadKeys = [
          "attentionFactId",
          "committedCommandId",
          "executionId",
          "failureCode",
          "logicalActionId",
          "targetWorkspaceId",
        ];
        if (
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.causedByEventId !== undefined ||
          event.aggregateRef !== fact.targetWorkspaceId ||
          event.correlationRef !== fact.logicalActionId ||
          event.causedByCommandId !== fact.committedCommandId ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.attentionFactId !== String(payload.attentionFactId ?? "") ||
          fact.executionId !== String(payload.executionId ?? "") ||
          fact.targetWorkspaceId !== String(payload.targetWorkspaceId ?? "") ||
          fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
          fact.committedCommandId !==
            String(payload.committedCommandId ?? "") ||
          fact.failureCode !== String(payload.failureCode ?? "") ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "AssignWork binding event does not exactly match its immutable P9 fact",
          });
        }
        yield* attentionRows
          .putAssignWorkBindingFailure(fact, event.occurredAt)
          .pipe(Effect.mapError(projectionFailure));
      }
    }),
  reset: () =>
    Effect.gen(function* () {
      yield* attentionRows
        .resetProject(projectId)
        .pipe(Effect.mapError(projectionFailure));
      const legacyFailures = sourceFacts.listLegacyAdoptionFailures;
      const legacyResolutions = sourceFacts.listLegacyAdoptionResolutions;
      const putLegacy = attentionRows.putLegacyAdoptionFailure;
      if (
        legacyFailures !== undefined ||
        legacyResolutions !== undefined ||
        putLegacy !== undefined
      ) {
        if (
          legacyFailures === undefined ||
          legacyResolutions === undefined ||
          putLegacy === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "AH14 fact snapshots and marker writer are not all available",
          });
        }
        const [failureFacts, resolutionFacts] = yield* Effect.all([
          legacyFailures(projectId),
          legacyResolutions(projectId),
        ]).pipe(Effect.mapError(projectionFailure));
        const failureById = new Map(
          failureFacts.map((fact) => [fact.attentionFactId, fact]),
        );
        const removeLegacy = attentionRows.removeLegacyAdoptionFailure;
        if (removeLegacy === undefined) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "AH14 resolution snapshot has no P10 marker validation route",
          });
        }
        for (const resolution of resolutionFacts) {
          const failureFact = failureById.get(resolution.attentionFactId);
          if (failureFact === undefined) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-rebuild",
              reason: "AH14 resolution fact has no original failure fact",
            });
          }
          yield* removeLegacy(failureFact, resolution).pipe(
            Effect.mapError(projectionFailure),
          );
        }
        const resolvedIds = new Set(
          resolutionFacts.map((fact) => fact.attentionFactId),
        );
        for (const fact of failureFacts) {
          if (resolvedIds.has(fact.attentionFactId)) continue;
          yield* putLegacy(fact).pipe(Effect.mapError(projectionFailure));
        }
      }
      const deliverFacts = yield* sourceFacts
        .listDeliverReplayFailures(projectId)
        .pipe(Effect.mapError(projectionFailure));
      for (const fact of deliverFacts) {
        yield* attentionRows
          .putDeliverReplayFailure(fact)
          .pipe(Effect.mapError(projectionFailure));
      }
      const submittedFactsAvailable =
        sourceFacts.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* sourceFacts
              .isSubmittedDecisionBindingAvailable()
              .pipe(Effect.mapError(projectionFailure));
      const submittedMarkersAvailable =
        attentionRows.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* attentionRows
              .isSubmittedDecisionBindingAvailable()
              .pipe(Effect.mapError(projectionFailure));
      if (submittedFactsAvailable !== submittedMarkersAvailable) {
        return yield* Effect.fail<ConsumerOffsetStoreError>({
          _tag: "PersistenceCorruption",
          repository: "ConsumerOffsetStore",
          operation: "p10-attention-rebuild",
          reason:
            "Submitted Decision fact and Attention marker availability do not converge",
        });
      }
      if (submittedFactsAvailable) {
        if (
          sourceFacts.listSubmittedDecisionBindingFailures === undefined ||
          attentionRows.putSubmittedDecisionBindingFailure === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "Submitted Decision fact snapshot has no P10 marker write route",
          });
        }
        const submittedFacts = yield* sourceFacts
          .listSubmittedDecisionBindingFailures(projectId)
          .pipe(Effect.mapError(projectionFailure));
        for (const fact of submittedFacts) {
          yield* attentionRows
            .putSubmittedDecisionBindingFailure(fact)
            .pipe(Effect.mapError(projectionFailure));
        }
      }
      if (
        sandboxUnavailableFacts !== undefined ||
        sandboxUnavailableQueue !== undefined
      ) {
        if (
          sandboxUnavailableFacts === undefined ||
          sandboxUnavailableQueue === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "sandbox-provider-unavailable-rebuild",
            reason:
              "P50 fact snapshot and queue re-arm ports are not both available",
          });
        }
        const sandboxFacts = yield* sandboxUnavailableFacts
          .list(projectId)
          .pipe(Effect.mapError(projectionFailure));
        for (const fact of sandboxFacts) {
          yield* sandboxUnavailableQueue
            .rearm(fact)
            .pipe(Effect.mapError(projectionFailure));
        }
      }
      const pending = yield* sourceFacts
        .listPendingDeliverReplayAttention(projectId, Number.MAX_SAFE_INTEGER)
        .pipe(Effect.mapError(projectionFailure));
      for (const fact of pending) {
        yield* sourceFacts
          .acknowledgePendingDeliverReplayAttention(fact.attentionFactId)
          .pipe(Effect.mapError(projectionFailure));
      }
      yield* attentionRows
        .reconcileStaleWorkRevisionRows(projectId)
        .pipe(Effect.mapError(projectionFailure));
      if (activationIntents === undefined) return;
      const intents = yield* activationIntents
        .listAll()
        .pipe(Effect.mapError(projectionFailure));
      yield* attentionRows
        .reconcileWorkspaceResourceActivation(projectId, intents)
        .pipe(Effect.mapError(projectionFailure));
    }),
});

