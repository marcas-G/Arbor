import {
  encodeEffectivePolicySummaryV2,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV3,
  executionEpisode,
  isIsoTimestamp,
  type SandboxPolicyDecisionCommittedInternalV3,
} from "@arbor/domain";
import type {
  ClockService,
  ExecutionRepositoryService,
  SandboxPolicyDecisionStoreService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway-contracts.js";
import {
  resolveCurrentWorkspaceSandboxAuthorization,
  type WorkspaceSandboxAuthorizationReadDependencies,
} from "../workspace-sandbox-authorization.js";
import {
  type DecideSandboxPolicyPayload,
  type DecideSandboxPolicyPreparation,
  decodePreparedSandboxPolicyDecision,
  sandboxPolicyPreconditionMismatch,
  sandboxPolicySnapshotMismatch,
} from "./decide-sandbox-policy.js";

/** Internal request: no external codec or model tool exposes this command. */
export type BindWorkspaceSandboxPolicyPayload = DecideSandboxPolicyPayload & {
  readonly expectedAuthorizationRevision: number;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly networkPolicy: Extract<
    DecideSandboxPolicyPayload["networkPolicy"],
    { kind: "OsEnforced" }
  >;
  readonly providerVersion: string;
  readonly capabilityRevision: number;
};

export interface BindWorkspaceSandboxPolicyDependencies
  extends WorkspaceSandboxAuthorizationReadDependencies {
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findById" | "findEpisodeRevision"
  >;
  readonly decisions: SandboxPolicyDecisionStoreService;
  readonly preparation: DecideSandboxPolicyPreparation;
  readonly clock: Pick<ClockService, "now">;
}

/** Standing authorization supplies the ceiling, never a fabricated human Grant.
 * The current source chain and prepared host facts are reread under Gateway's
 * transaction before the immutable decision, event and receipt commit together.
 * Staged only: production registration waits for the complete schema57 slice. */
export const makeBindWorkspaceSandboxPolicyHandler = (
  dependencies: BindWorkspaceSandboxPolicyDependencies,
): CommandHandler<
  BindWorkspaceSandboxPolicyPayload,
  SandboxPolicyDecisionCommittedInternalV3
> => ({
  commandType: "BindWorkspaceSandboxPolicy",
  schemaVersion: "1",
  authority: {
    tag: "WorkspaceSandboxPolicyBindingAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "WorkspaceSandboxPolicyBindingAuthority" &&
      authority.projectId === payload.projectId &&
      authority.workspaceId === payload.workspaceId &&
      authority.executionId === payload.executionId &&
      authority.workspaceAuthorizationRevision ===
        payload.expectedAuthorizationRevision &&
      encodeExecutionEpisodeBinding(authority.episodeBinding) ===
        encodeExecutionEpisodeBinding(payload.episodeBinding),
  },
  stopAdmission: { _tag: "Unclassified" },
  prepare: (envelope, context, authority) => {
    if (
      context._tag !== "System" ||
      authority._tag !== "WorkspaceSandboxPolicyBindingAuthority"
    ) {
      return Effect.fail({
        _tag: "TransactionOperationalFailure",
        cause: "Workspace policy binding requires internal authority",
      });
    }
    return dependencies.preparation
      .prepare(envelope.payload, authority)
      .pipe(Effect.map((summary) => ({ _tag: "Ready", summary })));
  },
  execute: (envelope, context, prepared) =>
    Effect.gen(function* () {
      const { payload, resolvedAuthority: authority } = envelope;
      const denied = () =>
        commandErr({
          _tag: "AuthorityDenied" as const,
          reason:
            "Workspace sandbox binding authority changed or is unavailable",
        });
      if (
        context._tag !== "System" ||
        authority?._tag !== "WorkspaceSandboxPolicyBindingAuthority" ||
        context.principal !== authority.principal ||
        context.causationRef !== envelope.causationRef ||
        authority.commandId !== envelope.commandId ||
        authority.projectId !== envelope.projectId ||
        payload.projectId !== envelope.projectId ||
        authority.workspaceId !== payload.workspaceId ||
        authority.executionId !== payload.executionId ||
        authority.episodeRevision !== payload.expectedEpisodeRevision ||
        authority.workspaceAuthorizationRevision !==
          payload.expectedAuthorizationRevision ||
        encodeExecutionEpisodeBinding(authority.episodeBinding) !==
          encodeExecutionEpisodeBinding(payload.episodeBinding)
      )
        return denied();
      const now = yield* dependencies.clock.now();
      if (!isIsoTimestamp(now)) return denied();
      const current = yield* resolveCurrentWorkspaceSandboxAuthorization(
        dependencies,
        {
          projectId: envelope.projectId,
          workspaceId: payload.workspaceId,
          now,
        },
      );
      if (
        current._tag !== "Authorized" ||
        current.authorization.authorizationRevision !==
          payload.expectedAuthorizationRevision
      )
        return denied();
      const authorization = current.authorization;
      if (
        payload.networkPolicy.kind !== "OsEnforced" ||
        authorization.profile !== payload.profile ||
        authorization.providerId !== payload.providerId ||
        encodeNetworkPolicyV1(authorization.networkPolicy) !==
          encodeNetworkPolicyV1(payload.networkPolicy.policy)
      )
        return denied();
      if (
        !isIsoTimestamp(payload.decisionExpiresAt) ||
        Date.parse(payload.decisionExpiresAt) <= Date.parse(now) ||
        (authorization.expiresAt !== null &&
          Date.parse(payload.decisionExpiresAt) >
            Date.parse(authorization.expiresAt))
      )
        return commandErr({ _tag: "DecisionExpiryInvalid" });
      const sourceStale =
        yield* dependencies.preparation.preIntentSourceStaleField(payload, now);
      if (sourceStale !== undefined)
        return commandErr({
          _tag: "StaleSandboxPolicyInputs",
          safeDetails: { field: sourceStale },
        });
      const execution = yield* dependencies.executions.findById(
        payload.executionId,
      );
      const revision = yield* dependencies.executions.findEpisodeRevision(
        payload.executionId,
      );
      const episode = Option.isSome(execution)
        ? executionEpisode(execution.value)
        : undefined;
      if (
        Option.isNone(execution) ||
        execution.value.state.status !== "Active" ||
        execution.value.stopRequestedAt !== null ||
        execution.value.projectId !== envelope.projectId ||
        execution.value.workspaceId !== payload.workspaceId ||
        episode === undefined ||
        encodeExecutionEpisodeBinding(episode) !==
          encodeExecutionEpisodeBinding(payload.episodeBinding) ||
        Option.isNone(revision) ||
        revision.value !== payload.expectedEpisodeRevision
      )
        return commandErr({
          _tag: "StaleSandboxPolicyInputs",
          safeDetails: { field: "EpisodeRevision" },
        });
      const latest = yield* dependencies.decisions.findCurrentForExecution(
        envelope.projectId,
        payload.workspaceId,
        payload.executionId,
      );
      const currentRevision = Option.isSome(latest)
        ? latest.value.decision.policyRevision
        : 0;
      const preconditions =
        yield* dependencies.preparation.currentPreconditions(payload);
      const mismatch = sandboxPolicyPreconditionMismatch(
        payload,
        currentRevision,
        preconditions,
      );
      if (mismatch !== undefined) return commandErr(mismatch);
      if (
        encodeExecutionEpisodeBinding(preconditions.episodeBinding) !==
        encodeExecutionEpisodeBinding(payload.episodeBinding)
      )
        return commandErr({
          _tag: "StaleSandboxPolicyInputs",
          safeDetails: { field: "EpisodeRevision" },
        });
      const ready = decodePreparedSandboxPolicyDecision(prepared);
      if (ready?._tag !== "Ready" || ready.summary.version !== 2)
        return commandErr({ _tag: "SandboxAuthorityUnavailable" });
      const snapshot = ready.summary;
      const snapshotMismatch = sandboxPolicySnapshotMismatch(
        payload,
        currentRevision,
        preconditions,
        snapshot,
      );
      if (snapshotMismatch !== undefined) return commandErr(snapshotMismatch);
      const result: SandboxPolicyDecisionCommittedInternalV3 = {
        version: 3,
        workspaceAuthorizationRevision: authorization.authorizationRevision,
        commandId: envelope.commandId,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        executionId: payload.executionId,
        episodeBinding: payload.episodeBinding,
        policyRevision: snapshot.policyRevision,
        policyDigest: sha256Hex(encodeEffectivePolicySummaryV2(snapshot)),
        effectivePolicySnapshot: snapshot,
      };
      if (
        new TextEncoder().encode(
          encodeSandboxPolicyDecisionCommittedInternalV3(result),
        ).byteLength > 65_536
      )
        return commandErr({ _tag: "SandboxPolicySummaryTooLarge" });
      yield* dependencies.decisions.insertCommitted({
        authorityKind: "WorkspaceAuthorization",
        workspaceAuthorizationRevision: authorization.authorizationRevision,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        executionId: payload.executionId,
        episodeBinding: payload.episodeBinding,
        policyRevision: result.policyRevision,
        expectedExecutionRevision: payload.expectedEpisodeRevision,
        expectedPolicyRevision: currentRevision,
        profile: payload.profile,
        providerId: payload.providerId,
        networkPolicy: payload.networkPolicy,
        policyDigest: result.policyDigest,
        operatorConfigRevision: snapshot.operatorConfigRevision,
        operatorConfigDigest: snapshot.operatorConfigDigest,
        actorPrincipal: context.principal,
        decisionCommandId: envelope.commandId,
        issuedAt: now,
        expiresAt: payload.decisionExpiresAt,
      });
      return commandOk({
        result,
        events: [
          {
            projectId: envelope.projectId,
            eventType: "SandboxPolicyDecisionRecorded",
            eventVersion: 2,
            occurredAt: now,
            aggregateRef: payload.executionId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              workspaceId: payload.workspaceId,
              executionId: payload.executionId,
              episodeBinding: payload.episodeBinding,
              policyRevision: result.policyRevision,
              workspaceAuthorizationRevision:
                authorization.authorizationRevision,
              operatorConfigRevision: snapshot.operatorConfigRevision,
              operatorConfigDigest: snapshot.operatorConfigDigest,
            },
          },
        ],
      });
    }),
});
