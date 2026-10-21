import type {
  CommandId,
  EffectivePolicySummaryV1,
  ExecutionEpisodeBinding,
  ExecutionId,
  ProjectId,
  SandboxNetworkPolicySelectionV1,
  SandboxProfile,
  WorkspaceId,
} from "@arbor/domain";
import {
  decodeEffectivePolicySummaryV1,
  decodeSandboxNetworkPolicySelectionV1,
  encodeEffectivePolicySummaryV1,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  executionEpisode,
  isIsoTimestamp,
  type SandboxPolicyPreconditionsV1,
} from "@arbor/domain";
import type {
  ClockService,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  PendingDomainEvent,
  PermissionGrantRepositoryService,
  ResourceOwnershipRepositoryError,
  SandboxPolicyDecisionStoreError,
  SandboxPolicyDecisionStoreService,
  SandboxPolicyPreIntentStaleField,
  ToolObservationEvidenceStoreError,
  TransactionOperationalFailure,
  TransactionScope,
  WorkspaceRepositoryError,
  WorktreeStoreError,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";
import type { CommandRejection } from "../rejection.js";

/** Exact human-authored V21 request. Trusted authority, provenance, host
 * evidence, clocks and environment snapshots are deliberately not wire data. */
interface DecideSandboxPolicyPayloadBase {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly expectedPolicyRevision: number;
  readonly expectedWorkspaceRevision: number;
  readonly expectedResourceBoundaryRevision: number;
  readonly expectedSandboxHandleBindingDigest: string;
  readonly expectedAuthorityBundleRevision: number;
  readonly expectedAuthorityBundleDigest: string;
  readonly expectedOperatorConfigRevision: number;
  readonly expectedOperatorConfigDigest: string;
  readonly expectedProviderRegistryRevision?: number;
  readonly expectedProviderRegistryDigest?: string;
  readonly profile: SandboxProfile;
  readonly providerId: string;
  readonly decisionExpiresAt: string;
}

type OsEnforcedNetworkPolicySelection = Extract<
  SandboxNetworkPolicySelectionV1,
  { readonly kind: "OsEnforced" }
>;
type TrustedLocalNetworkPolicySelection = Extract<
  SandboxNetworkPolicySelectionV1,
  { readonly kind: "TrustedLocalUnconfinedV1" }
>;

/** Schema 2 requires an exact selector for new OsEnforced commands. The
 * fieldless OsEnforced branch exists only to replay old receipts or commit the
 * accepted current-schema SandboxAuthorityUnavailable rejection. */
export type DecideSandboxPolicyPayload = DecideSandboxPolicyPayloadBase &
  (
    | {
        readonly networkPolicy: OsEnforcedNetworkPolicySelection;
        readonly providerVersion: string;
        readonly capabilityRevision: number;
      }
    | {
        readonly networkPolicy: OsEnforcedNetworkPolicySelection;
        readonly providerVersion?: never;
        readonly capabilityRevision?: never;
      }
    | {
        readonly networkPolicy: TrustedLocalNetworkPolicySelection;
        readonly providerVersion?: never;
        readonly capabilityRevision?: never;
      }
  );

export interface DecideSandboxPolicyPreparation {
  readonly prepare: (
    payload: DecideSandboxPolicyPayload,
    authority: Extract<
      import("../authority.js").CommandAuthorityFact,
      { readonly _tag: "SandboxPolicyDecisionAuthority" }
    >,
  ) => Effect.Effect<EffectivePolicySummaryV1, TransactionOperationalFailure>;
  /** Re-read exact Workspace/resource/mount/authority inputs under the P1
   * transaction. This is deliberately separate from provider probing. */
  readonly currentPreconditions: (
    payload: DecideSandboxPolicyPayload,
  ) => Effect.Effect<
    SandboxPolicyPreconditionsV1,
    | WorkspaceRepositoryError
    | ExecutionRepositoryError
    | SandboxPolicyDecisionStoreError
    | ResourceOwnershipRepositoryError
    | WorktreeStoreError,
    TransactionScope
  >;
  /** Final transaction source CAS; called before common revision CAS so
   * Action/approval stale precedence remains deterministic. */
  readonly preIntentSourceStaleField: (
    payload: DecideSandboxPolicyPayload,
    trustedNow: string,
  ) => Effect.Effect<
    SandboxPolicyPreIntentStaleField | undefined,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
}

type PreparedSandboxPolicyDecision =
  | {
      readonly _tag: "Ready";
      readonly summary: EffectivePolicySummaryV1;
    }
  | {
      readonly _tag: "Rejected";
      readonly rejection: Extract<
        CommandRejection,
        { readonly _tag: "SandboxAuthorityUnavailable" }
      >;
    };

const decodePreparedSandboxPolicyDecision = (
  value: unknown,
): PreparedSandboxPolicyDecision | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (record._tag === "Rejected") {
    return Object.keys(record).length === 2 &&
      Object.hasOwn(record, "rejection") &&
      typeof record.rejection === "object" &&
      record.rejection !== null &&
      !Array.isArray(record.rejection) &&
      Object.keys(record.rejection).length === 1 &&
      (record.rejection as Record<string, unknown>)._tag ===
        "SandboxAuthorityUnavailable"
      ? {
          _tag: "Rejected",
          rejection: { _tag: "SandboxAuthorityUnavailable" },
        }
      : undefined;
  }
  if (
    record._tag === "Ready" &&
    Object.keys(record).length === 2 &&
    Object.hasOwn(record, "summary") &&
    typeof record.summary === "object" &&
    record.summary !== null &&
    !Array.isArray(record.summary)
  ) {
    return {
      _tag: "Ready",
      summary: record.summary as EffectivePolicySummaryV1,
    };
  }
  return undefined;
};

export interface DecideSandboxPolicyDependencies {
  readonly grants: Pick<
    PermissionGrantRepositoryService,
    "findById" | "findSandboxPolicyGrantIssuerProvenanceByGrantId"
  >;
  readonly executions: Pick<
    ExecutionRepositoryService,
    "findById" | "findEpisodeRevision"
  >;
  readonly decisions: SandboxPolicyDecisionStoreService;
  readonly preparation: DecideSandboxPolicyPreparation;
  readonly clock: Pick<ClockService, "now">;
}

const stale = (
  field: Extract<
    CommandRejection,
    { _tag: "StaleSandboxPolicyInputs" }
  >["safeDetails"]["field"],
): CommandRejection => ({
  _tag: "StaleSandboxPolicyInputs",
  safeDetails: { field },
});

const sameEpisode = (
  left: ExecutionEpisodeBinding,
  right: ExecutionEpisodeBinding,
): boolean =>
  encodeExecutionEpisodeBinding(left) === encodeExecutionEpisodeBinding(right);

const preconditionMismatch = (
  payload: DecideSandboxPolicyPayload,
  expectedPolicyRevision: number,
  current: SandboxPolicyPreconditionsV1,
): CommandRejection | undefined => {
  if (payload.expectedEpisodeRevision !== current.expectedEpisodeRevision)
    return stale("EpisodeRevision");
  if (
    payload.expectedPolicyRevision !== current.latestCommittedPolicyRevision ||
    expectedPolicyRevision !== current.latestCommittedPolicyRevision
  )
    return stale("PolicyRevision");
  if (payload.expectedWorkspaceRevision !== current.workspaceRevision)
    return stale("WorkspaceRevision");
  if (
    payload.expectedResourceBoundaryRevision !==
    current.resourceBoundaryRevision
  )
    return stale("ResourceBoundaryRevision");
  if (
    payload.expectedSandboxHandleBindingDigest !==
    current.sandboxHandleBindingDigest
  )
    return stale("SandboxHandleBindingDigest");
  if (
    payload.expectedAuthorityBundleRevision !==
      current.authorityBundleRevision ||
    payload.expectedAuthorityBundleDigest !== current.authorityBundleDigest
  )
    return stale("AuthorityBundleRevision");
  if (
    payload.expectedOperatorConfigRevision !== current.operatorConfigRevision ||
    payload.expectedOperatorConfigDigest !== current.operatorConfigDigest
  )
    return stale("OperatorConfigRevision");
  if (current.kind === "OsEnforced") {
    if (
      payload.expectedProviderRegistryRevision !==
        current.providerRegistryRevision ||
      payload.expectedProviderRegistryDigest !== current.providerRegistryDigest
    )
      return stale("ProviderRegistryRevision");
  } else if (
    payload.expectedProviderRegistryRevision !== undefined ||
    payload.expectedProviderRegistryDigest !== undefined
  ) {
    return stale("ProviderRegistryRevision");
  }
  return undefined;
};

export const makeDecideSandboxPolicyHandler = (
  dependencies: DecideSandboxPolicyDependencies,
): CommandHandler<DecideSandboxPolicyPayload, unknown> => ({
  commandType: "DecideSandboxPolicy",
  schemaVersion: "2",
  priorReceiptSchemaVersions: ["1"],
  authority: {
    tag: "SandboxPolicyDecisionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SandboxPolicyDecisionAuthority" &&
      authority.projectId === payload.projectId &&
      authority.workspaceId === payload.workspaceId &&
      authority.executionId === payload.executionId &&
      sameEpisode(authority.episodeBinding, payload.episodeBinding),
  },
  stopAdmission: { _tag: "Unclassified" },
  prepare: (envelope, _context, resolvedAuthority) => {
    const authority = resolvedAuthority;
    if (authority?._tag !== "SandboxPolicyDecisionAuthority") {
      return Effect.fail({
        _tag: "TransactionOperationalFailure",
        cause: "sandbox decision preparation requires resolved authority",
      });
    }
    if (
      envelope.payload.networkPolicy.kind === "OsEnforced" &&
      envelope.payload.providerVersion === undefined &&
      envelope.payload.capabilityRevision === undefined
    ) {
      return Effect.succeed({
        _tag: "Rejected",
        rejection: { _tag: "SandboxAuthorityUnavailable" },
      } satisfies PreparedSandboxPolicyDecision);
    }
    return dependencies.preparation.prepare(envelope.payload, authority).pipe(
      Effect.map(
        (summary) =>
          ({
            _tag: "Ready",
            summary,
          }) satisfies PreparedSandboxPolicyDecision,
      ),
    );
  },
  execute: (envelope, _context, prepared) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const authority = envelope.resolvedAuthority;
      const preparedDecision = decodePreparedSandboxPolicyDecision(prepared);
      if (authority?._tag !== "SandboxPolicyDecisionAuthority") {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "sandbox decision authority missing",
        });
      }
      if (preparedDecision === undefined) {
        return commandErr({ _tag: "SandboxAuthorityUnavailable" });
      }
      const currentNow = yield* dependencies.clock.now();
      if (!isIsoTimestamp(currentNow)) {
        return commandErr({ _tag: "SandboxAuthorityUnavailable" });
      }
      const grant = yield* dependencies.grants.findById(
        authority.permissionGrant.permissionGrantId,
      );
      if (
        Option.isNone(grant) ||
        JSON.stringify(grant.value) !==
          JSON.stringify(authority.permissionGrant)
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "sandbox decision grant binding changed",
        });
      }
      const provenance =
        yield* dependencies.grants.findSandboxPolicyGrantIssuerProvenanceByGrantId(
          authority.permissionGrant.permissionGrantId,
        );
      if (
        Option.isNone(provenance) ||
        JSON.stringify(provenance.value) !==
          JSON.stringify(authority.issuerProvenance)
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "sandbox decision issuer provenance changed",
        });
      }
      if (
        grant.value.state !== "Active" ||
        grant.value.capability !== "DecideSandboxPolicy" ||
        grant.value.target !== payload.executionId ||
        grant.value.subject?._tag !== "HumanPrincipal" ||
        grant.value.subject.principal !== authority.principal ||
        grant.value.validFrom === undefined ||
        !isIsoTimestamp(grant.value.validFrom) ||
        Date.parse(currentNow) < Date.parse(grant.value.validFrom) ||
        grant.value.expiresAt == null ||
        !isIsoTimestamp(grant.value.expiresAt) ||
        Date.parse(currentNow) >= Date.parse(grant.value.expiresAt)
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "sandbox decision Grant is not active",
        });
      }
      const preIntentSourceStaleField =
        yield* dependencies.preparation.preIntentSourceStaleField(
          payload,
          currentNow,
        );
      if (preIntentSourceStaleField !== undefined)
        return commandErr(stale(preIntentSourceStaleField));
      const execution = yield* dependencies.executions.findById(
        payload.executionId,
      );
      const episodeRevision =
        yield* dependencies.executions.findEpisodeRevision(payload.executionId);
      const actualEpisode = Option.isSome(execution)
        ? executionEpisode(execution.value)
        : undefined;
      if (
        Option.isNone(execution) ||
        execution.value.projectId !== payload.projectId ||
        execution.value.workspaceId !== payload.workspaceId ||
        execution.value.state.status !== "Active" ||
        actualEpisode === undefined ||
        !sameEpisode(actualEpisode, payload.episodeBinding) ||
        Option.isNone(episodeRevision) ||
        episodeRevision.value !== payload.expectedEpisodeRevision
      ) {
        return commandErr(stale("EpisodeRevision"));
      }
      const latest = yield* dependencies.decisions.findCurrentForExecution(
        payload.projectId,
        payload.workspaceId,
        payload.executionId,
      );
      const currentRevision = Option.isSome(latest)
        ? latest.value.decision.policyRevision
        : 0;
      const currentPreconditions =
        yield* dependencies.preparation.currentPreconditions(payload);
      const mismatch = preconditionMismatch(
        payload,
        currentRevision,
        currentPreconditions,
      );
      if (mismatch !== undefined) return commandErr(mismatch);
      if (
        !sameEpisode(
          currentPreconditions.episodeBinding,
          payload.episodeBinding,
        ) ||
        currentPreconditions.expectedEpisodeRevision !==
          payload.expectedEpisodeRevision
      )
        return commandErr(stale("EpisodeRevision"));

      if (preparedDecision._tag === "Rejected")
        return commandErr(preparedDecision.rejection);
      if (
        !isIsoTimestamp(payload.decisionExpiresAt) ||
        Date.parse(payload.decisionExpiresAt) <= Date.parse(currentNow) ||
        Date.parse(payload.decisionExpiresAt) >
          Date.parse(grant.value.expiresAt)
      )
        return commandErr({ _tag: "DecisionExpiryInvalid" });

      const decodedSelection = decodeSandboxNetworkPolicySelectionV1(
        payload.networkPolicy,
      );
      const snapshot = decodeEffectivePolicySummaryV1(
        preparedDecision.summary,
        sha256Hex,
      );
      if (
        decodedSelection === undefined ||
        snapshot === undefined ||
        snapshot.projectId !== payload.projectId ||
        snapshot.workspaceId !== payload.workspaceId ||
        snapshot.executionId !== payload.executionId ||
        !sameEpisode(snapshot.episodeBinding, payload.episodeBinding) ||
        snapshot.policyRevision !== currentRevision + 1 ||
        snapshot.expiresAt !== payload.decisionExpiresAt ||
        (snapshot.kind === "OsEnforced"
          ? decodedSelection.kind !== "OsEnforced" ||
            snapshot.profile !== payload.profile ||
            snapshot.providerId !== payload.providerId ||
            payload.providerVersion === undefined ||
            payload.capabilityRevision === undefined ||
            snapshot.providerVersion !== payload.providerVersion ||
            snapshot.capabilityRevision !== payload.capabilityRevision ||
            encodeNetworkPolicyV1(snapshot.networkPolicy) !==
              encodeNetworkPolicyV1(decodedSelection.policy)
          : decodedSelection.kind !== "TrustedLocalUnconfinedV1" ||
            payload.profile !== "FullAccess" ||
            payload.providerId !== "TrustedLocal")
      )
        return commandErr({ _tag: "SandboxAuthorityUnavailable" });
      if (snapshot.workspaceRevision !== currentPreconditions.workspaceRevision)
        return commandErr(stale("WorkspaceRevision"));
      if (
        snapshot.resourceBoundaryRevision !==
        currentPreconditions.resourceBoundaryRevision
      )
        return commandErr(stale("ResourceBoundaryRevision"));
      if (
        snapshot.sandboxHandleBindingDigest !==
        currentPreconditions.sandboxHandleBindingDigest
      )
        return commandErr(stale("SandboxHandleBindingDigest"));
      if (
        snapshot.authorityBundleRevision !==
          currentPreconditions.authorityBundleRevision ||
        snapshot.authorityBundleDigest !==
          currentPreconditions.authorityBundleDigest
      )
        return commandErr(stale("AuthorityBundleRevision"));
      if (
        snapshot.operatorConfigRevision !==
          currentPreconditions.operatorConfigRevision ||
        snapshot.operatorConfigDigest !==
          currentPreconditions.operatorConfigDigest
      )
        return commandErr(stale("OperatorConfigRevision"));
      if (
        snapshot.kind === "OsEnforced" &&
        (currentPreconditions.kind !== "OsEnforced" ||
          snapshot.providerRegistryRevision !==
            currentPreconditions.providerRegistryRevision ||
          snapshot.providerRegistryDigest !==
            currentPreconditions.providerRegistryDigest)
      )
        return commandErr(stale("ProviderRegistryRevision"));

      const policyDigest = sha256Hex(encodeEffectivePolicySummaryV1(snapshot));
      const result = {
        version: 1 as const,
        commandId: envelope.commandId as CommandId,
        projectId: payload.projectId,
        workspaceId: payload.workspaceId,
        executionId: payload.executionId,
        episodeBinding: payload.episodeBinding,
        policyRevision: snapshot.policyRevision,
        policyDigest,
        effectivePolicySnapshot: snapshot,
      };
      const canonicalResult =
        encodeSandboxPolicyDecisionCommittedInternalV1(result);
      if (new TextEncoder().encode(canonicalResult).byteLength > 65_536)
        return commandErr({ _tag: "SandboxPolicySummaryTooLarge" });
      const decision = {
        projectId: payload.projectId,
        workspaceId: payload.workspaceId,
        executionId: payload.executionId,
        episodeBinding: payload.episodeBinding,
        policyRevision: snapshot.policyRevision,
        expectedExecutionRevision: payload.expectedEpisodeRevision,
        expectedPolicyRevision: currentRevision,
        profile: payload.profile,
        providerId: payload.providerId,
        networkPolicy: decodedSelection,
        policyDigest,
        permissionGrantId: grant.value.permissionGrantId,
        grantPermissionCommandId: provenance.value.grantPermissionCommandId,
        grantIssuerPrincipal: provenance.value.issuerPrincipal,
        operatorConfigRevision: snapshot.operatorConfigRevision,
        operatorConfigDigest: snapshot.operatorConfigDigest,
        actorPrincipal: authority.principal,
        decisionCommandId: envelope.commandId,
        issuedAt: currentNow,
        expiresAt: payload.decisionExpiresAt,
      };
      yield* dependencies.decisions.insertCommitted(decision);
      const event: PendingDomainEvent = {
        projectId: payload.projectId,
        eventType: "SandboxPolicyDecisionRecorded",
        eventVersion: 1,
        occurredAt: currentNow,
        aggregateRef: payload.executionId,
        actor: envelope.actor,
        payload: {
          workspaceId: payload.workspaceId,
          executionId: payload.executionId,
          episodeBinding: payload.episodeBinding,
          policyRevision: snapshot.policyRevision,
          permissionGrantId: grant.value.permissionGrantId,
          operatorConfigRevision: snapshot.operatorConfigRevision,
          operatorConfigDigest: snapshot.operatorConfigDigest,
        },
      };
      return commandOk({ result, events: [event] });
    }),
});
