import type {
  DomainEvent,
  ExecutionId,
  VerificationId,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import type {
  BlobStorePortService,
  ClockService,
  DomainEventJournalService,
  ExecutionRepositoryService,
  ProjectRepositoryService,
  RetryVerificationOriginRepositoryService,
  VerificationRepositoryService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ParentUserGovernanceFacts } from "../authority-resolver.js";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";
import { makeConcludeVerificationHandler } from "./conclude-verification.js";
import { makeStartVerificationHandler } from "./start-verification.js";

/** P8 RetryVerification is a human-only handoff. The client supplies exact
 * stale-source bindings and preallocates both successor identities so the
 * command receipt and post-commit spawn can be replayed without new ids. */
export interface RetryVerificationPayload {
  readonly workId: WorkId;
  readonly verificationId: VerificationId;
  readonly expectedWorkRevision: WorkRevision;
  readonly summaryContent: string;
  readonly successorVerificationId: VerificationId;
  readonly verifierExecutionId: ExecutionId;
}

export interface RetryVerificationResult {
  readonly workId: WorkId;
  readonly orphanedVerificationId: VerificationId;
  readonly successorVerificationId: VerificationId;
  readonly verifierExecutionId: ExecutionId;
  readonly state: "OrphanedAndRetried";
}

export interface RetryVerificationDependencies {
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly verifications: Pick<
    VerificationRepositoryService,
    "findById" | "findByExecutionId"
  >;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly projects: Pick<ProjectRepositoryService, "findById">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly origins: Pick<
    RetryVerificationOriginRepositoryService,
    "insertOrigin"
  > &
    Partial<Pick<RetryVerificationOriginRepositoryService, "findOrigin">>;
  readonly journal?: Pick<
    DomainEventJournalService,
    "lastSequence" | "readAfter"
  >;
  readonly clock: Pick<ClockService, "now">;
  readonly blobs: Pick<BlobStorePortService, "put" | "get">;
  readonly governance: ParentUserGovernanceFacts;
  readonly start: Parameters<typeof makeStartVerificationHandler>[0];
  readonly conclude: Parameters<typeof makeConcludeVerificationHandler>[0];
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

const recordOf = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> =>
  recordOf(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const replayBindingFailure = () =>
  Effect.fail({
    _tag: "PersistenceCorruption" as const,
    repository: "CommandStore" as const,
    operation: "retry-verification-replay-binding",
    reason:
      "RetryVerification receipt does not match canonical row/event truth",
  });

/** P8 human retry. Both P8 state transitions are invoked inside the one outer
 * CommandGateway transaction; the persisted successor verification is also
 * the durable, preallocated spawn intent consumed by the existing verifier
 * recovery consumer after commit. */
export const makeRetryVerificationHandler = (
  dependencies: RetryVerificationDependencies,
): CommandHandler<RetryVerificationPayload, RetryVerificationResult> => {
  const start = makeStartVerificationHandler(dependencies.start);
  const conclude = makeConcludeVerificationHandler(dependencies.conclude);
  return {
    commandType: "RetryVerification",
    schemaVersion: "1",
    authority: {
      tag: "RetryVerificationAuthority",
      targetMatches: (authority, payload) => {
        return (
          authority._tag === "RetryVerificationAuthority" &&
          authority.workId === payload.workId &&
          authority.verificationId === payload.verificationId &&
          authority.expectedWorkRevision === payload.expectedWorkRevision &&
          authority.settledVerifierExecutionIds.length > 0
        );
      },
    },
    stopAdmission: { _tag: "NormalExecutionMutation" },
    validateReceiptReplay: (receipt, payload, envelope, _context) =>
      Effect.gen(function* () {
        if (receipt.resolution._tag !== "Committed") return;
        const result = receipt.resolution.result as RetryVerificationResult;
        if (
          receipt.schemaVersion !== "1" ||
          result.state !== "OrphanedAndRetried" ||
          result.workId !== payload.workId ||
          result.orphanedVerificationId !== payload.verificationId ||
          result.successorVerificationId !== payload.successorVerificationId ||
          result.verifierExecutionId !== payload.verifierExecutionId ||
          dependencies.origins.findOrigin === undefined ||
          dependencies.journal === undefined
        ) {
          return yield* replayBindingFailure();
        }
        const origin = yield* dependencies.origins.findOrigin(
          receipt.commandId,
        );
        if (
          Option.isNone(origin) ||
          origin.value.commandId !== receipt.commandId ||
          origin.value.projectId !== receipt.projectId ||
          String(origin.value.actor) !== String(envelope.actor) ||
          origin.value.sourceVerificationId !== payload.verificationId ||
          origin.value.sourceWorkId !== payload.workId ||
          origin.value.successorVerificationId !==
            payload.successorVerificationId ||
          origin.value.successorVerifierExecutionId !==
            payload.verifierExecutionId
        ) {
          return yield* replayBindingFailure();
        }
        const sourceOption = yield* dependencies.verifications.findById(
          payload.verificationId,
        );
        const successorOption = yield* dependencies.verifications.findById(
          payload.successorVerificationId,
        );
        if (Option.isNone(sourceOption) || Option.isNone(successorOption)) {
          return yield* replayBindingFailure();
        }
        const source = sourceOption.value;
        const successor = successorOption.value;
        if (
          source.workId !== payload.workId ||
          source.targetWorkRevision !== payload.expectedWorkRevision ||
          source.state.status !== "Concluded" ||
          source.state.verdict !== "Unknown" ||
          source.state.conclusionReason !== "Orphaned" ||
          successor.workId !== source.workId ||
          successor.targetWorkRevision !== source.targetWorkRevision ||
          successor.ownerWorkspaceId !== source.ownerWorkspaceId ||
          JSON.stringify(successor.missionSnapshot) !==
            JSON.stringify(source.missionSnapshot) ||
          successor.state.status !== "Open" ||
          successor.snapshotStatus !== "Pending" ||
          successor.criteriaResults !== null ||
          !successor.verificationExecutionIds.includes(
            payload.verifierExecutionId,
          )
        ) {
          return yield* replayBindingFailure();
        }

        const journal = dependencies.journal;
        const finalSequence = yield* journal.lastSequence(receipt.projectId);
        const events: DomainEvent<unknown>[] = [];
        let sequence = 0;
        while (sequence < finalSequence) {
          const page = yield* journal.readAfter(
            receipt.projectId,
            sequence,
            1000,
          );
          if (page.length === 0) break;
          events.push(...page);
          const next = Number(page[page.length - 1]?.sequence ?? sequence);
          if (next <= sequence) return yield* replayBindingFailure();
          sequence = next;
        }
        const sourcedEvents = events.filter(
          (event) => event.causedByCommandId === receipt.commandId,
        );
        const starts = sourcedEvents.filter(
          (event) => event.eventType === "VerificationStarted",
        );
        const conclusions = sourcedEvents.filter(
          (event) => event.eventType === "VerificationConcluded",
        );
        const start = starts[0];
        const conclusion = conclusions[0];
        const startPayload = start?.payload;
        const conclusionPayload = conclusion?.payload;
        if (
          starts.length !== 1 ||
          conclusions.length !== 1 ||
          start === undefined ||
          conclusion === undefined ||
          start.eventVersion !== 1 ||
          start.aggregateRef !== payload.successorVerificationId ||
          start.projectId !== receipt.projectId ||
          String(start.actor) !== String(origin.value.actor) ||
          !hasExactKeys(startPayload, [
            "verificationId",
            "workId",
            "targetWorkRevision",
            "missionDigest",
          ]) ||
          startPayload.verificationId !== payload.successorVerificationId ||
          startPayload.workId !== payload.workId ||
          startPayload.targetWorkRevision !== payload.expectedWorkRevision ||
          startPayload.missionDigest !==
            `${source.missionSnapshot.goal} [criteria=${source.missionSnapshot.criteria.length} required=${source.missionSnapshot.criteria.filter((criterion) => criterion.required).length}]` ||
          conclusion.aggregateRef !== payload.verificationId ||
          conclusion.projectId !== receipt.projectId ||
          String(conclusion.actor) !== String(origin.value.actor) ||
          conclusionPayload === null ||
          !recordOf(conclusionPayload)
        ) {
          return yield* replayBindingFailure();
        }
        if (source.snapshotStatus === "NotApplicableOrphaned") {
          if (
            conclusion.eventVersion !== 2 ||
            !hasExactKeys(conclusionPayload, [
              "verificationId",
              "workId",
              "targetWorkRevision",
              "verdict",
              "conclusionReason",
              "evidenceRefs",
              "summaryRef",
              "missionSnapshot",
              "criteriaResults",
              "snapshotStatus",
            ]) ||
            conclusionPayload.verdict !== "Unknown" ||
            conclusionPayload.conclusionReason !== "Orphaned" ||
            !Array.isArray(conclusionPayload.evidenceRefs) ||
            conclusionPayload.evidenceRefs.length !== 0 ||
            conclusionPayload.summaryRef !== source.summaryRef ||
            JSON.stringify(conclusionPayload.missionSnapshot) !==
              JSON.stringify(source.missionSnapshot) ||
            JSON.stringify(conclusionPayload.criteriaResults) !== "[]" ||
            conclusionPayload.snapshotStatus !== "NotApplicableOrphaned"
          ) {
            return yield* replayBindingFailure();
          }
        } else if (source.snapshotStatus === "UnavailableLegacy") {
          if (
            conclusion.eventVersion !== 1 ||
            !hasExactKeys(conclusionPayload, [
              "verificationId",
              "workId",
              "targetWorkRevision",
              "verdict",
              "conclusionReason",
              "evidenceRefs",
              "summaryRef",
            ]) ||
            conclusionPayload.verdict !== "Unknown" ||
            conclusionPayload.conclusionReason !== "Orphaned" ||
            !Array.isArray(conclusionPayload.evidenceRefs) ||
            conclusionPayload.evidenceRefs.length !== 0 ||
            conclusionPayload.summaryRef !== source.summaryRef
          ) {
            return yield* replayBindingFailure();
          }
        } else {
          return yield* replayBindingFailure();
        }
        if (
          conclusionPayload.verificationId !== payload.verificationId ||
          conclusionPayload.workId !== payload.workId ||
          conclusionPayload.targetWorkRevision !== payload.expectedWorkRevision
        ) {
          return yield* replayBindingFailure();
        }
      }),
    execute: (envelope, context) =>
      Effect.gen(function* () {
        const payload = envelope.payload;
        if (
          context._tag !== "External" ||
          payload.verificationId === payload.successorVerificationId
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "RetryVerification requires an authenticated human and a fresh successor id",
          });
        }
        const workOption = yield* dependencies.works.findById(payload.workId);
        if (
          Option.isNone(workOption) ||
          workOption.value.projectId !== envelope.projectId
        ) {
          return commandErr({ _tag: "WorkNotFound", workId: payload.workId });
        }
        const work = workOption.value;
        if (work.lifecycle !== "Open") {
          return commandErr({
            _tag: "TerminalLifecycleMutation",
            entity: "Work",
            lifecycle: work.lifecycle,
          });
        }
        if (work.revision !== payload.expectedWorkRevision) {
          return commandErr({
            _tag: "RevisionConflict",
            expected: payload.expectedWorkRevision,
            actual: work.revision,
          });
        }
        const projectOption = yield* dependencies.projects.findById(
          envelope.projectId,
        );
        if (Option.isNone(projectOption)) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "project is unavailable",
          });
        }
        const principal = context.principal;
        const authenticatedHuman =
          principal.startsWith("user:") ||
          dependencies.governance.authenticatedHumans.includes(principal);
        const isRoot = work.workspaceId === projectOption.value.rootWorkspaceId;
        let ownerAuthorized = isRoot && authenticatedHuman;
        if (!isRoot && authenticatedHuman) {
          const workspace = yield* dependencies.workspaces.findById(
            work.workspaceId,
          );
          ownerAuthorized =
            Option.isSome(workspace) &&
            workspace.value.projectId === envelope.projectId &&
            dependencies.governance.directParentOf.some(
              (edge) =>
                edge.workspaceId === work.workspaceId &&
                edge.parentPrincipal === principal,
            );
        }
        if (!ownerAuthorized) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "RetryVerification requires Root local human or exact direct-Parent human authority",
          });
        }

        const oldOption = yield* dependencies.verifications.findById(
          payload.verificationId,
        );
        if (Option.isNone(oldOption)) {
          return commandErr({
            _tag: "VerificationNotFound",
            verificationId: payload.verificationId,
          });
        }
        const old = oldOption.value;
        if (
          old.workId !== payload.workId ||
          old.targetWorkRevision !== payload.expectedWorkRevision ||
          old.state.status !== "Open" ||
          old.ownerWorkspaceId === undefined ||
          old.verificationExecutionIds.length === 0
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "source Verification is not the exact open orphan candidate",
          });
        }
        const resolved = envelope.resolvedAuthority;
        const boundIds = old.verificationExecutionIds.toSorted();
        if (
          resolved?._tag !== "RetryVerificationAuthority" ||
          resolved.principal !== context.principal ||
          resolved.projectId !== envelope.projectId ||
          resolved.workId !== payload.workId ||
          resolved.verificationId !== payload.verificationId ||
          resolved.expectedWorkRevision !== payload.expectedWorkRevision ||
          resolved.currentOwnerId !== work.workspaceId ||
          resolved.targetWorkspaceId !== work.workspaceId ||
          resolved.settledVerifierExecutionIds.length !== boundIds.length ||
          resolved.settledVerifierExecutionIds.some(
            (id, index) => id !== boundIds[index],
          )
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "resolved RetryVerification authority no longer matches the exact canonical snapshot",
          });
        }
        for (const executionId of old.verificationExecutionIds) {
          const execution =
            yield* dependencies.executions.findById(executionId);
          const bound =
            yield* dependencies.verifications.findByExecutionId(executionId);
          if (
            Option.isNone(execution) ||
            execution.value.projectId !== envelope.projectId ||
            execution.value.workspaceId !== old.ownerWorkspaceId ||
            execution.value.binding._tag !== "ExecutionBoundAgentBinding" ||
            execution.value.state.status !== "Settled" ||
            Option.isNone(bound) ||
            bound.value.verificationId !== old.verificationId
          ) {
            return commandErr({
              _tag: "AuthorityDenied",
              reason:
                "every source verifier execution must be settled, exact-bound, and at the frozen owner",
            });
          }
        }

        const bytes = new TextEncoder().encode(payload.summaryContent);
        const summaryRef = yield* dependencies.blobs.put(bytes);
        const storedBytes = yield* dependencies.blobs.get(summaryRef);
        if (!equalBytes(bytes, storedBytes)) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "stored orphan summary failed byte verification",
          });
        }
        const innerEnvelope = {
          ...envelope,
          commandType: "ConcludeVerification",
          payload: {
            verificationId: old.verificationId,
            verdict: "Unknown" as const,
            criteriaResults: [],
            summaryRef,
            conclusionReason: "Orphaned" as const,
          },
        };
        const concluded = yield* conclude.execute(innerEnvelope, context);
        if (!concluded.ok) return concluded;

        const successorEnvelope = {
          ...envelope,
          commandType: "StartVerification",
          payload: {
            verificationId: payload.successorVerificationId,
            workId: old.workId,
            observedWorkRevision: payload.expectedWorkRevision,
            missionSnapshot: old.missionSnapshot,
            targetDeliverables: old.targetDeliverables,
            verifierExecutionId: payload.verifierExecutionId,
            executableMission: old.targetEnvironmentRevision !== null,
          },
        };
        const successor = yield* start.execute(successorEnvelope, context);
        if (!successor.ok) {
          // Do not return a terminal rejection after the old row has already
          // been concluded: that would let the Gateway commit a half handoff.
          // This can only indicate a violated precondition/race inside the
          // transaction; defecting forces the owning transaction to roll back
          // so a retry can re-resolve the exact source state.
          return yield* Effect.die(
            new Error(
              `RetryVerification successor admission failed after source conclusion: ${successor.error._tag}`,
            ),
          );
        }
        const createdAt = yield* dependencies.clock.now();
        yield* dependencies.origins.insertOrigin({
          commandId: envelope.commandId,
          projectId: envelope.projectId,
          actor: context.principal,
          sourceVerificationId: payload.verificationId,
          sourceWorkId: payload.workId,
          successorVerificationId: payload.successorVerificationId,
          successorVerifierExecutionId: payload.verifierExecutionId,
          createdAt,
        });
        return commandOk({
          result: {
            workId: payload.workId,
            orphanedVerificationId: payload.verificationId,
            successorVerificationId: payload.successorVerificationId,
            verifierExecutionId: payload.verifierExecutionId,
            state: "OrphanedAndRetried" as const,
          },
          events: [...concluded.value.events, ...successor.value.events],
        });
      }),
  };
};
