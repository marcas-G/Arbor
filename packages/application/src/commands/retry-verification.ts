import type {
  ExecutionId,
  VerificationId,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import type {
  BlobStorePortService,
  ExecutionRepositoryService,
  ProjectRepositoryService,
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
  readonly blobs: Pick<BlobStorePortService, "put" | "get">;
  readonly governance: ParentUserGovernanceFacts;
  readonly start: Parameters<typeof makeStartVerificationHandler>[0];
  readonly conclude: Parameters<typeof makeConcludeVerificationHandler>[0];
}

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

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
      alsoTags: ["RetryVerificationReceiptReplayAuthority"],
      targetMatches: (authority, payload) => {
        if (authority._tag === "RetryVerificationReceiptReplayAuthority") {
          return (
            authority.workId === payload.workId &&
            authority.verificationId === payload.verificationId &&
            authority.expectedWorkRevision === payload.expectedWorkRevision
          );
        }
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
