import type {
  CommandId,
  CommandSubmissionContext,
  ExecutionEpisodeBinding,
  ExecutionId,
  FormationProposalId,
  PermissionGrant,
  PermissionGrantId,
  PluginId,
  PluginVersion,
  Principal,
  ProjectId,
  ProjectPolicy,
  SandboxPolicyAuthoritySnapshotV2,
  SandboxPolicyGrantIssuerProvenanceV1,
  SemanticRequestFingerprint,
  VerificationId,
  WorkId,
  WorkspaceId,
  WorkspacePolicy,
  WorkspaceSandboxAuthorizationSnapshot,
} from "@arbor/domain";
import {
  decodeExecutionEpisodeBinding,
  encodeExecutionEpisodeBinding,
  isIsoTimestamp,
  resolveWorkspaceSandboxAuthorization,
} from "@arbor/domain";
import type {
  InvocationApproval,
  InvocationAuthority,
  RetryVerificationOriginRecord,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";
import type { CommandAuthorityFact } from "./authority.js";
import type { GatewayEnvelope } from "./gateway.js";

/**
 * P12 `02` §1–§6 (DID v1.14 G2, v1.13 G4; TR-8): the Authority Resolver
 * production plane.
 *
 * The resolver is a **pure / deterministic authority-decision boundary**. It
 * produces exact-bound trusted authority facts only; it is side-effect free
 * with respect to canonical state. It MUST NOT invoke the command gateway,
 * mutate canonical state (no repository writes, no event append), consume an
 * `InvocationApproval`, or execute tools. Canonical mutation remains only
 * through the command gateway (DID §10.4).
 *
 * `R = never` is the proof of no I/O / no side effect: every read is of the
 * declared inputs below; the resolver holds no ambient capability.
 */

/** The principal proven at the transport/composition boundary (DID §4.1);
 * never model-supplied. Distinct name from the domain `Principal` only to
 * mark provenance. */
export type AuthenticatedPrincipal = Principal;

/** P12 `02` §2: project/workspace/work/execution state snapshot. Declared
 * input, not a live I/O port. */
export interface CanonicalWorkspaceSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly lifecycle?: "Active" | "Retired";
  readonly revision?: number;
}

export interface CanonicalExecutionSnapshot {
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly status?: "Active" | "Settled";
  readonly episodeRevision?: number;
  readonly episodeBinding?: ExecutionEpisodeBinding;
}

export interface CanonicalWorkSnapshot {
  readonly workId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open" | "Completed" | "Cancelled";
  readonly revision?: number;
}

export interface CanonicalRetryVerificationSnapshot {
  readonly verificationId: VerificationId;
  readonly workId: WorkId;
  readonly targetWorkRevision: number;
  readonly state: "Open" | "Concluded";
  readonly ownerWorkspaceId: WorkspaceId;
  readonly verifierExecutions: ReadonlyArray<{
    readonly executionId: ExecutionId;
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly status: "Active" | "Settled" | "Missing";
    readonly executionBound: boolean;
    readonly boundToVerification: boolean;
  }>;
}

export interface CanonicalAuthorityFacts {
  readonly projectId: ProjectId;
  readonly project?: { readonly rootWorkspaceId: WorkspaceId };
  readonly workspace?: CanonicalWorkspaceSnapshot;
  readonly execution?: CanonicalExecutionSnapshot;
  readonly work?: CanonicalWorkSnapshot;
  readonly retryVerification?: CanonicalRetryVerificationSnapshot;
  readonly retryVerificationOrigin?: RetryVerificationOriginRecord;
  readonly executableApproval?: {
    readonly approvalId: string;
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly executionId: ExecutionId;
    readonly state: string;
    readonly revision: number;
  };
}

/** P12 `02` §2: parent/child/user override facts (SD §8.1 authority model).
 * `authenticatedHumans` are the final governance source (Human Override);
 * `directParentOf` are the direct parent->child governance edges. */
export interface ParentUserGovernanceFacts {
  readonly authenticatedHumans: ReadonlyArray<Principal>;
  readonly directParentOf: ReadonlyArray<{
    readonly workspaceId: WorkspaceId;
    readonly parentPrincipal: Principal;
  }>;
}

export interface AuthorityDecisionInput {
  readonly principal: AuthenticatedPrincipal;
  readonly submissionContext: CommandSubmissionContext;
  readonly envelope: GatewayEnvelope<unknown>;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly canonicalFacts: CanonicalAuthorityFacts;
  /** Active grants only, loaded by the composition root from the grant store
   * (`state = 'Active'`); a revoked grant is never loaded. */
  readonly grants: ReadonlyArray<PermissionGrant>;
  readonly governance: ParentUserGovernanceFacts;
  readonly policy: ProjectPolicy | WorkspacePolicy;
  /** P5 startup-only snapshot from the OS-protected trusted host source.
   * Missing means sandbox issuer authority is unavailable. */
  readonly sandboxPolicyGrantIssuerConfigSnapshot?: SandboxPolicyAuthoritySnapshotV2;
  /** Composition/Resolver trusted instant. Sandbox-specific CAPA checks never
   * use caller-controlled CommandEnvelope.issuedAt. */
  readonly sandboxPolicyAuthorityNow?: string;
  /** Exact immutable provenance loaded by the composition root for the one
   * resolver-selected CAPA grant; never caller-provided. */
  readonly sandboxPolicyGrantIssuerProvenance?: SandboxPolicyGrantIssuerProvenanceV1;
  /** Current-head ancestor snapshot, read under one canonical transaction.
   * This is trusted composition input, never external/model wire data. */
  readonly workspaceSandboxAuthorizationSnapshot?: WorkspaceSandboxAuthorizationSnapshot;
  readonly workspaceSandboxAuthorizationNow?: string;
  /** Host provenance only; this input confers no legacy human issuer authority. */
  readonly workspaceSandboxPolicyHostSnapshot?: Pick<
    SandboxPolicyAuthoritySnapshotV2,
    | "authorityBundleRevision"
    | "authorityBundleDigest"
    | "providerRegistryRevision"
    | "providerRegistryDigest"
    | "operatorConfigRevision"
    | "operatorConfigDigest"
  >;
}

/** P4 `03` §2/§4 invocation-scoped facts. `AuthorityDecisionInput` cannot
 * produce `InvocationAuthority` / `InvocationApproval` (N-03): those need the
 * resolved tool intent, the resolved regions, `controlBasisDigest`,
 * `expiresAt`, and `delegationDepth`, none of which a command envelope
 * carries. */
export interface InvocationDecisionInput {
  readonly principal: AuthenticatedPrincipal;
  readonly projectId?: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly intent: {
    readonly toolName: string;
    readonly toolVersion: string;
    readonly argumentsJson: string;
    readonly actionDigest: string;
    readonly sideEffectSemantics?: import("@arbor/ports").SideEffectSemantics;
    readonly requestedCapabilities: ReadonlyArray<string>;
    readonly resolvedRegions: ReadonlyArray<string>;
  };
  readonly controlBasisDigest: string;
  readonly grants: ReadonlyArray<PermissionGrant>;
  /** Current effective Workspace authorization projected by composition.
   * This is standing capability, not a synthetic PermissionGrant and not an
   * exact-action approval. */
  readonly workspaceAuthorizationCapabilities?: ReadonlyArray<string>;
  readonly governance: ParentUserGovernanceFacts;
  readonly policy: ProjectPolicy | WorkspacePolicy;
  readonly delegationDepth: number;
  readonly approvalIdentity?: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly actionIndex: number;
    readonly logicalActionId: string;
    readonly callRef: string;
    readonly toolInvocationId: import("@arbor/domain").ToolInvocationId;
  };
  /** Canonical runtime role projected from durable execution binding. */
  readonly executionRole?: "Verifier";
  readonly now: string;
}

export type AuthorityResolutionError =
  | {
      readonly _tag: "NoApplicableGrant";
      readonly principal: AuthenticatedPrincipal;
      readonly commandType: string;
      readonly commandId: CommandId;
    }
  | {
      readonly _tag: "GrantScopeInsufficient";
      readonly principal: AuthenticatedPrincipal;
      readonly commandType: string;
      readonly requiredScope: string;
    }
  | {
      readonly _tag: "GovernanceOverrideDenied";
      readonly principal: AuthenticatedPrincipal;
      readonly targetWorkspaceId: WorkspaceId;
    }
  | {
      readonly _tag: "ApprovalIntentMismatch";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly _tag: "UnsupportedOrigin";
      readonly submissionOrigin: string;
      readonly commandType: string;
    };

export type InvocationResolutionError =
  | {
      readonly _tag: "NoApplicableGrant";
      readonly principal: AuthenticatedPrincipal;
      readonly toolName: string;
    }
  | {
      readonly _tag: "GrantScopeInsufficient";
      readonly principal: AuthenticatedPrincipal;
      readonly requiredScope: string;
    }
  | {
      readonly _tag: "CapabilityCeilingExceeded";
      readonly requested: ReadonlyArray<string>;
      readonly allowed: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "DelegationCeilingExceeded";
      readonly delegationDepth: number;
      readonly ceiling: number;
    }
  | {
      readonly _tag: "GovernanceOverrideDenied";
      readonly principal: AuthenticatedPrincipal;
      readonly targetWorkspaceId: WorkspaceId;
    }
  | {
      readonly _tag: "ApprovalIntentMismatch";
      readonly expected: string;
      readonly actual: string;
    };

export interface AuthorityResolverPortService {
  /** Command / runtime authority facts (envelope-scoped). */
  readonly resolve: (
    input: AuthorityDecisionInput,
  ) => Effect.Effect<CommandAuthorityFact, AuthorityResolutionError, never>;

  /** P4 `03` §2 production plane: the tool-invocation authority fact. */
  readonly resolveInvocation: (
    input: InvocationDecisionInput,
  ) => Effect.Effect<InvocationAuthority, InvocationResolutionError, never>;

  /** P4 `03` §4 production plane: the Exact-Intent approval record
   * (produced here, NEVER consumed). */
  readonly resolveApproval: (
    input: InvocationDecisionInput,
  ) => Effect.Effect<InvocationApproval, InvocationResolutionError, never>;
}

export class AuthorityResolverPort extends Context.Service<
  AuthorityResolverPort,
  AuthorityResolverPortService
>()("arbor/AuthorityResolverPort") {}

// --- resolver-local derivation (choice (b), P12 `02` §5) ---------------------
//
// The frozen P0 `PermissionGrant` carries only `scope: string`. The resolver
// DERIVES subject/capability from the grant scope + governance facts; it does
// not mutate the domain type (no added `subject`/`capability` fields). The
// scope encoding below is the resolver's derivation of the SD §8 model:
//
//   scope := capability ["@" targetId]
//
// `capability` names the command type (governance) or the tool capability
// (invocation); an optional `@targetId` narrows the grant to one target. `*`
// is a capability wildcard.

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const payloadString = (payload: unknown, key: string): string | null => {
  const value = payloadRecord(payload)[key];
  return typeof value === "string" ? value : null;
};

const payloadNumber = (payload: unknown, key: string): number | null => {
  const value = payloadRecord(payload)[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
};

const isAuthenticatedHuman = (input: {
  readonly principal: Principal;
  readonly governance: ParentUserGovernanceFacts;
}): boolean =>
  input.principal.startsWith("user:") ||
  input.governance.authenticatedHumans.includes(input.principal);

const governanceAuthorizes = (
  governance: ParentUserGovernanceFacts,
  principal: Principal,
  target: string | null,
): boolean =>
  target !== null &&
  governance.directParentOf.some(
    (edge) => edge.parentPrincipal === principal && edge.workspaceId === target,
  );

type GrantMatch = "Match" | "WrongTarget" | "None";

const matchGrant = (
  grants: ReadonlyArray<PermissionGrant>,
  capability: string,
  target: string | null,
  subject: {
    readonly principal: Principal;
    readonly workspaceId: WorkspaceId | null;
    readonly executionId: ExecutionId | null;
    readonly now: string;
  },
): GrantMatch => {
  let wrongTarget = false;
  for (const grant of grants) {
    if (grant.state !== "Active") {
      continue;
    }
    if (
      grant.subject === undefined ||
      grant.capability === undefined ||
      grant.validFrom === undefined ||
      Date.parse(subject.now) < Date.parse(grant.validFrom) ||
      (grant.expiresAt != null &&
        Date.parse(subject.now) >= Date.parse(grant.expiresAt))
    ) {
      continue;
    }
    const subjectMatches =
      (grant.subject._tag === "HumanPrincipal" &&
        grant.subject.principal === subject.principal) ||
      (grant.subject._tag === "WorkspaceAgent" &&
        grant.subject.workspaceId === subject.workspaceId) ||
      (grant.subject._tag === "Execution" &&
        grant.subject.executionId === subject.executionId);
    if (!subjectMatches) {
      continue;
    }
    if (grant.capability !== capability && grant.capability !== "*") {
      continue;
    }
    if (grant.target != null && grant.target !== target) {
      wrongTarget = true;
      continue;
    }
    return "Match";
  }
  return wrongTarget ? "WrongTarget" : "None";
};

type AuthOutcome = "Granted" | "WrongTarget" | "Denied";

const authorizeCommand = (
  input: AuthorityDecisionInput,
  capability: string,
  target: string | null,
): AuthOutcome => {
  if (isAuthenticatedHuman(input)) {
    return "Granted";
  }
  if (governanceAuthorizes(input.governance, input.principal, target)) {
    return "Granted";
  }
  const match = matchGrant(input.grants, capability, target, {
    principal: input.principal,
    workspaceId:
      input.canonicalFacts.execution?.workspaceId ??
      input.canonicalFacts.workspace?.workspaceId ??
      null,
    executionId: input.canonicalFacts.execution?.executionId ?? null,
    now: input.envelope.issuedAt,
  });
  if (match === "Match") {
    return "Granted";
  }
  return match === "WrongTarget" ? "WrongTarget" : "Denied";
};

const denyCommand = (
  input: AuthorityDecisionInput,
  capability: string,
  outcome: AuthOutcome,
): AuthorityResolutionError =>
  outcome === "WrongTarget"
    ? {
        _tag: "GrantScopeInsufficient",
        principal: input.principal,
        commandType: input.envelope.commandType,
        requiredScope: capability,
      }
    : {
        _tag: "NoApplicableGrant",
        principal: input.principal,
        commandType: input.envelope.commandType,
        commandId: input.envelope.commandId,
      };

const readPolicyNumber = (
  policy: ProjectPolicy | WorkspacePolicy,
  key: string,
  fallback: number,
): number => {
  const value = (policy as Readonly<Record<string, unknown>>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const addSeconds = (now: string, seconds: number): string =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();

const externalRuntimeFact = (
  input: AuthorityDecisionInput,
  commandType: "AdmitExecution" | "StopExecution",
): Effect.Effect<CommandAuthorityFact, AuthorityResolutionError, never> => {
  const payload = input.envelope.payload;
  const principal = input.principal;
  const commandId = input.envelope.commandId;
  const semanticRequestFingerprint = input.semanticRequestFingerprint;
  const projectId = input.envelope.projectId;

  if (commandType === "AdmitExecution") {
    const workspaceId =
      input.canonicalFacts.workspace?.workspaceId ??
      (payloadString(payload, "workspaceId") as WorkspaceId | null);
    const outcome = authorizeCommand(input, "AdmitExecution", workspaceId);
    if (outcome !== "Granted" || workspaceId === null) {
      return Effect.fail(denyCommand(input, "AdmitExecution", outcome));
    }
    const bindingKind =
      payloadString(payload, "bindingKind") === "ExecutionBound"
        ? "ExecutionBound"
        : "WorkspaceMain";
    return Effect.succeed({
      _tag: "AdmitExecutionAuthority",
      submissionOrigin: "External",
      principal,
      commandId,
      semanticRequestFingerprint,
      projectId,
      commandKind: "AdmitExecution",
      workspaceId,
      bindingKind,
    });
  }

  const executionId =
    input.canonicalFacts.execution?.executionId ??
    (payloadString(payload, "executionId") as ExecutionId | null);
  const outcome = authorizeCommand(input, "StopExecution", executionId);
  if (outcome !== "Granted" || executionId === null) {
    return Effect.fail(denyCommand(input, "StopExecution", outcome));
  }
  return Effect.succeed({
    _tag: "StopExecutionAuthority",
    submissionOrigin: "External",
    principal,
    commandId,
    semanticRequestFingerprint,
    projectId,
    commandKind: "StopExecution",
    executionId,
  });
};

const governanceCommandFact = (
  input: AuthorityDecisionInput,
): Effect.Effect<CommandAuthorityFact, AuthorityResolutionError, never> => {
  const commandType = input.envelope.commandType;
  const payload = input.envelope.payload;
  const principal = input.principal;
  const commandId = input.envelope.commandId;
  const semanticRequestFingerprint = input.semanticRequestFingerprint;
  const projectId = input.envelope.projectId;
  const workspaceId = input.canonicalFacts.workspace?.workspaceId ?? null;
  const _executionId = input.canonicalFacts.execution?.executionId ?? null;

  const guarded = (
    capability: string,
    target: string | null,
  ): AuthorityResolutionError | null => {
    const outcome = authorizeCommand(input, capability, target);
    return outcome === "Granted"
      ? null
      : denyCommand(input, capability, outcome);
  };

  switch (commandType) {
    case "AuthorizeWorkspaceSandbox":
    case "RevokeWorkspaceSandboxAuthorization": {
      const workspace = input.canonicalFacts.workspace;
      const context = input.submissionContext;
      const deny = () => Effect.fail(denyCommand(input, commandType, "Denied"));
      if (
        workspace === undefined ||
        workspace.projectId !== projectId ||
        input.canonicalFacts.projectId !== projectId ||
        workspace.lifecycle !== "Active" ||
        workspace.workspaceId !== payloadString(payload, "workspaceId") ||
        context.principal !== principal
      )
        return deny();
      const source = payloadRecord(payloadRecord(payload).source);
      if (
        context._tag === "External" &&
        input.governance.authenticatedHumans.includes(principal) &&
        (commandType === "RevokeWorkspaceSandboxAuthorization" ||
          source.kind === "Human")
      ) {
        return Effect.succeed({
          _tag: "WorkspaceSandboxAuthorizationAuthority",
          principal,
          commandId,
          semanticRequestFingerprint,
          projectId,
          workspaceId: workspace.workspaceId,
          commandKind: commandType,
          source: { kind: "Human" },
        });
      }
      const execution = input.canonicalFacts.execution;
      const snapshot = input.workspaceSandboxAuthorizationSnapshot;
      const now = input.workspaceSandboxAuthorizationNow;
      if (
        commandType !== "AuthorizeWorkspaceSandbox" ||
        context._tag !== "ExecutionOrigin" ||
        source.kind !== "Parent" ||
        workspace.parentWorkspaceId === null ||
        execution === undefined ||
        execution.executionId !== context.executionId ||
        execution.workspaceId !== workspace.parentWorkspaceId ||
        execution.projectId !== projectId ||
        execution.status !== "Active" ||
        execution.episodeBinding === undefined ||
        snapshot === undefined ||
        now === undefined
      )
        return deny();
      const parent = resolveWorkspaceSandboxAuthorization({
        ...snapshot,
        projectId,
        workspaceId: workspace.parentWorkspaceId,
        now,
      });
      if (
        parent._tag !== "Authorized" ||
        parent.authorization.authorizationRevision !==
          source.expectedParentAuthorizationRevision
      )
        return deny();
      return Effect.succeed({
        _tag: "WorkspaceSandboxAuthorizationAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        workspaceId: workspace.workspaceId,
        commandKind: commandType,
        source: {
          kind: "Parent",
          parentWorkspaceId: workspace.parentWorkspaceId,
          parentAuthorizationRevision:
            parent.authorization.authorizationRevision,
          parentExecutionId: context.executionId,
        },
      });
    }
    case "CreateProject": {
      const error = guarded("CreateProject", projectId);
      if (error !== null) {
        return Effect.fail(error);
      }
      return Effect.succeed({
        _tag: "CreateProjectAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
      });
    }
    case "RenameProject":
    case "CloseProject": {
      const error = guarded(commandType, projectId);
      if (error !== null) {
        return Effect.fail(error);
      }
      return Effect.succeed({
        _tag: "ProjectGovernanceAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        commandType,
      });
    }
    case "CreateChildWorkspace": {
      const parentWorkspaceId =
        input.canonicalFacts.workspace?.parentWorkspaceId ??
        (payloadString(payload, "parentWorkspaceId") as WorkspaceId | null);
      const error = guarded("CreateChildWorkspace", parentWorkspaceId);
      if (error !== null || parentWorkspaceId === null) {
        return Effect.fail(
          error ?? denyCommand(input, "CreateChildWorkspace", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "CreateChildWorkspaceAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        parentWorkspaceId,
      });
    }
    case "AssignWork": {
      const error = guarded("AssignWork", workspaceId);
      if (error !== null || workspaceId === null) {
        return Effect.fail(error ?? denyCommand(input, "AssignWork", "Denied"));
      }
      return Effect.succeed({
        _tag: "AssignWorkAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        targetWorkspaceId: workspaceId,
      });
    }
    case "SubmitHumanMessage": {
      // P14 `01` §1: root-only exact binding at the authority layer. The
      // human principal comes from the authenticated External context
      // (already authenticated by the caller of resolve); the payload never
      // declares a sender.
      const targetWorkspaceId = payloadString(
        payload,
        "targetWorkspaceId",
      ) as WorkspaceId | null;
      const messageId = payloadString(payload, "messageId");
      const rootWorkspaceId =
        input.canonicalFacts.project?.rootWorkspaceId ?? null;
      const error = guarded("SubmitHumanMessage", targetWorkspaceId);
      if (error !== null) {
        return Effect.fail(error);
      }
      if (targetWorkspaceId === null || messageId === null) {
        return Effect.fail(denyCommand(input, "SubmitHumanMessage", "Denied"));
      }
      // P14 `01` §2: root-only exact binding — a non-root target means the
      // human governance override does not apply to that target (the
      // external plane maps every resolver denial to 403 authority/denied).
      if (rootWorkspaceId === null || targetWorkspaceId !== rootWorkspaceId) {
        return Effect.fail({
          _tag: "GovernanceOverrideDenied",
          principal: input.principal,
          targetWorkspaceId,
        });
      }
      return Effect.succeed({
        _tag: "SubmitHumanMessageAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        targetWorkspaceId,
        messageId,
      });
    }
    case "RetryVerification": {
      // P8 / P12 human-only governance: deliberately bypass authorizeCommand
      // so PermissionGrants (including wildcard grants) cannot confer this
      // recovery authority.
      if (input.submissionContext._tag !== "External") {
        return Effect.fail({
          _tag: "UnsupportedOrigin",
          submissionOrigin: input.submissionContext._tag,
          commandType,
        });
      }
      const payloadWorkId = payloadString(payload, "workId") as WorkId | null;
      const verificationId = payloadString(
        payload,
        "verificationId",
      ) as VerificationId | null;
      const expectedRevision = payloadNumber(payload, "expectedWorkRevision");
      const facts = input.canonicalFacts;
      const work = facts.work;
      const retry = facts.retryVerification;
      const ownerWorkspaceId = work?.workspaceId ?? null;
      const origin = facts.retryVerificationOrigin;
      if (origin !== undefined) {
        const source = retry;
        const exactOriginScope =
          origin.commandId === commandId &&
          origin.projectId === projectId &&
          origin.actor === principal &&
          origin.sourceWorkId === payloadWorkId &&
          origin.sourceVerificationId === verificationId &&
          work !== undefined &&
          work.projectId === projectId &&
          work.workId === origin.sourceWorkId &&
          source !== undefined &&
          source.verificationId === origin.sourceVerificationId &&
          source.workId === origin.sourceWorkId &&
          source.ownerWorkspaceId === ownerWorkspaceId;
        if (!exactOriginScope || ownerWorkspaceId === null) {
          return Effect.fail(denyCommand(input, "RetryVerification", "Denied"));
        }
        const isRoot = facts.project?.rootWorkspaceId === ownerWorkspaceId;
        const humanAuthorized = isRoot
          ? isAuthenticatedHuman(input)
          : isAuthenticatedHuman(input) &&
            governanceAuthorizes(input.governance, principal, ownerWorkspaceId);
        if (!humanAuthorized) {
          return Effect.fail(denyCommand(input, "RetryVerification", "Denied"));
        }
        return Effect.succeed({
          _tag: "RetryVerificationReplayOnlyAuthority",
          principal,
          commandId,
          semanticRequestFingerprint,
          projectId,
          targetWorkspaceId: ownerWorkspaceId,
          currentOwnerId: ownerWorkspaceId,
          workId: origin.sourceWorkId,
          verificationId: origin.sourceVerificationId,
        });
      }
      const exact =
        payloadWorkId !== null &&
        verificationId !== null &&
        expectedRevision !== null &&
        work !== undefined &&
        work.projectId === projectId &&
        work.workId === payloadWorkId &&
        work.lifecycle === "Open" &&
        work.revision === expectedRevision &&
        retry !== undefined &&
        retry.verificationId === verificationId &&
        retry.workId === payloadWorkId &&
        retry.targetWorkRevision === expectedRevision &&
        retry.state === "Open" &&
        retry.verifierExecutions.length > 0 &&
        retry.verifierExecutions.every(
          (execution) =>
            execution.projectId === projectId &&
            execution.workspaceId === retry.ownerWorkspaceId &&
            execution.status === "Settled" &&
            execution.executionBound &&
            execution.boundToVerification,
        );
      if (!exact || ownerWorkspaceId === null || retry === undefined) {
        return Effect.fail(denyCommand(input, "RetryVerification", "Denied"));
      }
      const isRoot = facts.project?.rootWorkspaceId === ownerWorkspaceId;
      const humanAuthorized = isRoot
        ? isAuthenticatedHuman(input)
        : isAuthenticatedHuman(input) &&
          governanceAuthorizes(input.governance, principal, ownerWorkspaceId);
      if (!humanAuthorized) {
        return Effect.fail(denyCommand(input, "RetryVerification", "Denied"));
      }
      return Effect.succeed({
        _tag: "RetryVerificationAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        targetWorkspaceId: ownerWorkspaceId,
        currentOwnerId: ownerWorkspaceId,
        workId: payloadWorkId as WorkId,
        expectedWorkRevision: expectedRevision as number,
        verificationId,
        settledVerifierExecutionIds: retry.verifierExecutions
          .map((execution) => execution.executionId)
          .toSorted(),
      });
    }
    case "ResumeConversationResponse":
    case "CancelConversationResponse": {
      const messageId = payloadString(payload, "messageId");
      const rootWorkspaceId =
        input.canonicalFacts.project?.rootWorkspaceId ?? null;
      const error = guarded(commandType, rootWorkspaceId);
      if (error !== null) return Effect.fail(error);
      if (messageId === null || rootWorkspaceId === null) {
        return Effect.fail(denyCommand(input, commandType, "Denied"));
      }
      return Effect.succeed({
        _tag: "ConversationResponseAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        commandKind: commandType,
        messageId,
      });
    }
    case "SelectCurrentWork": {
      const error = guarded("SelectCurrentWork", workspaceId);
      if (error !== null || workspaceId === null) {
        return Effect.fail(
          error ?? denyCommand(input, "SelectCurrentWork", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "SelectCurrentWorkAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        targetWorkspaceId: workspaceId,
      });
    }
    case "RecordDecision": {
      // P6 D1 human gate: the fact binds the EXACT proposal being decided;
      // the handler's targetMatches enforces proposalId equality.
      const proposalId = payloadString(
        payload,
        "proposalId",
      ) as FormationProposalId | null;
      const error = guarded("RecordDecision", projectId);
      if (error !== null || proposalId === null) {
        return Effect.fail(
          error ?? denyCommand(input, "RecordDecision", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "RecordDecisionAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        proposalId,
      });
    }
    case "ResolveControlApproval": {
      const approvalId = payloadString(payload, "approvalId");
      const error = guarded("ResolveControlApproval", approvalId);
      if (error !== null || approvalId === null) {
        return Effect.fail(
          error ?? denyCommand(input, "ResolveControlApproval", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "ControlApprovalDecisionAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        approvalId,
      });
    }
    case "ResolveExecutableApproval": {
      const approvalId = payloadString(payload, "approvalId");
      const expectedRevision = payloadNumber(payload, "expectedRevision");
      const approval = input.canonicalFacts.executableApproval;
      const execution = input.canonicalFacts.execution;
      if (
        // Executable approval is a governance decision. The single-user
        // transport has one explicit local human principal; every other
        // human identity must be projected into the trusted governance set.
        // A caller-controlled `user:*` spelling must not approve execution.
        (principal !== "user:local" &&
          !input.governance.authenticatedHumans.includes(principal) &&
          !governanceAuthorizes(
            input.governance,
            principal,
            approval?.workspaceId ?? null,
          )) ||
        approvalId === null ||
        expectedRevision === null ||
        approval === undefined ||
        approval.approvalId !== approvalId ||
        approval.projectId !== projectId ||
        execution === undefined ||
        execution.executionId !== approval.executionId ||
        execution.projectId !== projectId ||
        execution.workspaceId !== approval.workspaceId ||
        execution.status !== "Active"
      ) {
        return Effect.fail(
          denyCommand(input, "ResolveExecutableApproval", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "ExecutableApprovalDecisionAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        approvalId,
        workspaceId: approval.workspaceId,
        executionId: approval.executionId,
        expectedRevision,
      });
    }
    case "SteerWork": {
      // P6 `04`: human steer — the fact binds the exact workspace + work.
      const steerWorkspaceId = payloadString(
        payload,
        "workspaceId",
      ) as WorkspaceId | null;
      const steerWorkId = payloadString(payload, "workId") as WorkId | null;
      const error = guarded("SteerWork", steerWorkspaceId);
      if (error !== null || steerWorkspaceId === null || steerWorkId === null) {
        return Effect.fail(error ?? denyCommand(input, "SteerWork", "Denied"));
      }
      return Effect.succeed({
        _tag: "SteerWorkAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        targetWorkspaceId: steerWorkspaceId,
        workId: steerWorkId,
      });
    }
    case "AcceptWorkOutcome": {
      // P8 `01` §4: parent acceptance — exact-bound to workId + verificationId.
      const acceptWorkId = payloadString(payload, "workId") as WorkId | null;
      const verificationId = payloadString(
        payload,
        "verificationId",
      ) as VerificationId | null;
      const acceptParent =
        input.canonicalFacts.workspace?.workspaceId ??
        input.canonicalFacts.work?.workspaceId ??
        (payloadString(payload, "workspaceId") as WorkspaceId | null);
      const error = guarded("AcceptWorkOutcome", acceptParent);
      if (
        error !== null ||
        acceptWorkId === null ||
        verificationId === null ||
        acceptParent === null
      ) {
        return Effect.fail(
          error ?? denyCommand(input, "AcceptWorkOutcome", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "AcceptanceAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        targetWorkspaceId: acceptParent,
        workId: acceptWorkId,
        verificationId,
      });
    }
    case "RegisterProjectTool": {
      const error = guarded("RegisterProjectTool", projectId);
      if (error !== null) {
        return Effect.fail(error);
      }
      const pluginId = payloadString(payload, "pluginId") as PluginId | null;
      const pluginVersion = payloadString(
        payload,
        "pluginVersion",
      ) as PluginVersion | null;
      const contentHash = payloadString(payload, "contentHash");
      if (pluginId === null || pluginVersion === null || contentHash === null) {
        return Effect.fail(denyCommand(input, "RegisterProjectTool", "Denied"));
      }
      return Effect.succeed({
        _tag: "RegisterProjectToolAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        pluginId,
        pluginVersion,
        contentHash,
      });
    }
    case "GrantPermission": {
      const permissionGrantId = payloadString(
        payload,
        "permissionGrantId",
      ) as PermissionGrantId | null;
      if (payloadRecord(payload).expiresAt === null) {
        const workspace = input.canonicalFacts.workspace;
        const permission = payloadRecord(payload);
        const subject = payloadRecord(permission.subject);
        if (
          input.submissionContext._tag !== "External" ||
          input.submissionContext.principal !== principal ||
          !input.governance.authenticatedHumans.includes(principal) ||
          permissionGrantId === null ||
          permission.issuer !== principal ||
          workspace === undefined ||
          workspace.projectId !== projectId ||
          input.canonicalFacts.projectId !== projectId ||
          workspace.lifecycle !== "Active" ||
          workspace.revision === undefined ||
          !Number.isSafeInteger(workspace.revision) ||
          workspace.revision < 0 ||
          subject._tag !== "WorkspaceAgent" ||
          subject.workspaceId !== workspace.workspaceId ||
          permission.target !== workspace.workspaceId ||
          (permission.capability !== "fs:write" &&
            permission.capability !== "shell:exec")
        ) {
          return Effect.fail(denyCommand(input, "GrantPermission", "Denied"));
        }
        return Effect.succeed({
          _tag: "GrantPermissionAuthority",
          principal,
          commandId,
          semanticRequestFingerprint,
          projectId,
          permissionGrantId,
          workspacePermissionBinding: {
            workspaceId: workspace.workspaceId,
            workspaceRevision: workspace.revision,
          },
        });
      }
      if (payloadString(payload, "capability") === "DecideSandboxPolicy") {
        const targetExecutionId = payloadString(payload, "target");
        const issuer = payloadString(payload, "issuer");
        const subjectValue = payloadRecord(payload).subject;
        const subject =
          typeof subjectValue === "object" &&
          subjectValue !== null &&
          !Array.isArray(subjectValue) &&
          (subjectValue as Record<string, unknown>)._tag === "HumanPrincipal" &&
          typeof (subjectValue as Record<string, unknown>).principal ===
            "string"
            ? ((subjectValue as Record<string, unknown>).principal as string)
            : null;
        const expiresAt = payloadString(payload, "expiresAt");
        const now = input.sandboxPolicyAuthorityNow;
        const snapshot = input.sandboxPolicyGrantIssuerConfigSnapshot;
        const execution = input.canonicalFacts.execution;
        if (
          input.submissionContext._tag !== "External" ||
          permissionGrantId === null ||
          targetExecutionId === null ||
          issuer !== principal ||
          subject === null ||
          subject === issuer ||
          !isAuthenticatedHuman(input) ||
          now === undefined ||
          !isIsoTimestamp(now) ||
          expiresAt === null ||
          !isIsoTimestamp(expiresAt) ||
          Date.parse(expiresAt) <= Date.parse(now) ||
          snapshot === undefined ||
          !Number.isSafeInteger(snapshot.config.revision) ||
          snapshot.config.revision < 1 ||
          !/^[0-9a-f]{64}$/u.test(snapshot.configDigest) ||
          !Number.isSafeInteger(snapshot.authorityBundleRevision) ||
          snapshot.authorityBundleRevision < 1 ||
          !/^[0-9a-f]{64}$/u.test(snapshot.authorityBundleDigest) ||
          !Number.isSafeInteger(snapshot.providerRegistryRevision) ||
          snapshot.providerRegistryRevision < 1 ||
          !/^[0-9a-f]{64}$/u.test(snapshot.providerRegistryDigest) ||
          !Number.isSafeInteger(snapshot.operatorConfigRevision) ||
          snapshot.operatorConfigRevision < 1 ||
          !/^[0-9a-f]{64}$/u.test(snapshot.operatorConfigDigest) ||
          !snapshot.config.issuers.includes(principal) ||
          execution === undefined ||
          execution.executionId !== targetExecutionId ||
          execution.projectId !== projectId ||
          execution.status !== "Active"
        ) {
          return Effect.fail(denyCommand(input, "GrantPermission", "Denied"));
        }
        return Effect.succeed({
          _tag: "GrantPermissionAuthority",
          principal,
          commandId,
          semanticRequestFingerprint,
          projectId,
          permissionGrantId,
          sandboxPolicyIssuerBinding: {
            executionId: execution.executionId,
            operatorConfigRevision: snapshot.operatorConfigRevision,
            operatorConfigDigest: snapshot.operatorConfigDigest,
            authorityBundleRevision: snapshot.authorityBundleRevision,
            authorityBundleDigest: snapshot.authorityBundleDigest,
            providerRegistryRevision: snapshot.providerRegistryRevision,
            providerRegistryDigest: snapshot.providerRegistryDigest,
          },
        });
      }
      const error = guarded("GrantPermission", permissionGrantId);
      if (error !== null || permissionGrantId === null) {
        return Effect.fail(
          error ?? denyCommand(input, "GrantPermission", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "GrantPermissionAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        permissionGrantId,
      });
    }
    case "BindWorkspaceSandboxPolicy": {
      const context = input.submissionContext;
      const execution = input.canonicalFacts.execution;
      const workspace = input.canonicalFacts.workspace;
      const snapshot = input.workspaceSandboxAuthorizationSnapshot;
      const host = input.workspaceSandboxPolicyHostSnapshot;
      const now = input.workspaceSandboxAuthorizationNow;
      const data = payloadRecord(payload);
      const episode = decodeExecutionEpisodeBinding(data.episodeBinding);
      const deny = () => Effect.fail(denyCommand(input, commandType, "Denied"));
      if (
        context._tag !== "System" ||
        context.principal !== principal ||
        context.causationRef !== input.envelope.causationRef ||
        input.canonicalFacts.projectId !== projectId ||
        data.projectId !== projectId ||
        execution === undefined ||
        workspace === undefined ||
        snapshot === undefined ||
        host === undefined ||
        now === undefined ||
        !isIsoTimestamp(now) ||
        execution.executionId !== data.executionId ||
        execution.workspaceId !== data.workspaceId ||
        execution.projectId !== projectId ||
        execution.status !== "Active" ||
        execution.episodeRevision !== data.expectedEpisodeRevision ||
        !Number.isSafeInteger(execution.episodeRevision) ||
        (execution.episodeRevision ?? -1) < 0 ||
        workspace.workspaceId !== execution.workspaceId ||
        workspace.projectId !== projectId ||
        workspace.lifecycle !== "Active" ||
        episode === undefined ||
        execution.episodeBinding === undefined ||
        encodeExecutionEpisodeBinding(episode) !==
          encodeExecutionEpisodeBinding(execution.episodeBinding)
      )
        return deny();
      for (const key of [
        "authorityBundle",
        "providerRegistry",
        "operatorConfig",
      ] as const) {
        if (
          !Number.isSafeInteger(host[`${key}Revision`]) ||
          host[`${key}Revision`] < 1 ||
          !/^[0-9a-f]{64}$/u.test(host[`${key}Digest`])
        )
          return deny();
      }
      const current = resolveWorkspaceSandboxAuthorization({
        ...snapshot,
        projectId,
        workspaceId: workspace.workspaceId,
        now,
      });
      if (
        current._tag !== "Authorized" ||
        current.authorization.authorizationRevision !==
          data.expectedAuthorizationRevision
      )
        return deny();
      return Effect.succeed({
        _tag: "WorkspaceSandboxPolicyBindingAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        workspaceId: workspace.workspaceId,
        executionId: execution.executionId,
        episodeBinding: episode,
        episodeRevision: execution.episodeRevision as number,
        workspaceAuthorizationRevision:
          current.authorization.authorizationRevision,
        ...host,
      });
    }
    case "DecideSandboxPolicy": {
      const targetExecutionId = payloadString(payload, "executionId");
      const targetWorkspaceId = payloadString(payload, "workspaceId");
      const payloadEpisode = decodeExecutionEpisodeBinding(
        payloadRecord(payload).episodeBinding,
      );
      const episode = input.canonicalFacts.execution;
      const snapshot = input.sandboxPolicyGrantIssuerConfigSnapshot;
      const now = input.sandboxPolicyAuthorityNow;
      const provenance = input.sandboxPolicyGrantIssuerProvenance;
      const selected = input.grants.filter(
        (grant) =>
          grant.state === "Active" &&
          grant.subject?._tag === "HumanPrincipal" &&
          grant.subject.principal === principal &&
          grant.capability === "DecideSandboxPolicy" &&
          grant.target === targetExecutionId &&
          grant.validFrom !== undefined &&
          now !== undefined &&
          Date.parse(grant.validFrom) <= Date.parse(now) &&
          grant.expiresAt != null &&
          Date.parse(now) < Date.parse(grant.expiresAt),
      );
      if (
        input.submissionContext._tag !== "External" ||
        !isAuthenticatedHuman(input) ||
        targetExecutionId === null ||
        targetWorkspaceId === null ||
        payloadString(payload, "projectId") !== projectId ||
        now === undefined ||
        !isIsoTimestamp(now) ||
        snapshot === undefined ||
        episode === undefined ||
        episode.executionId !== targetExecutionId ||
        episode.projectId !== projectId ||
        episode.workspaceId !== targetWorkspaceId ||
        episode.status !== "Active" ||
        !Number.isSafeInteger(episode.episodeRevision) ||
        episode.episodeRevision === undefined ||
        episode.episodeRevision < 0 ||
        episode.episodeBinding === undefined ||
        payloadEpisode === undefined ||
        encodeExecutionEpisodeBinding(payloadEpisode) !==
          encodeExecutionEpisodeBinding(episode.episodeBinding) ||
        selected.length !== 1 ||
        provenance === undefined
      ) {
        return Effect.fail(denyCommand(input, "DecideSandboxPolicy", "Denied"));
      }
      const grant = selected[0];
      if (
        grant === undefined ||
        grant.issuer !== provenance.issuerPrincipal ||
        provenance.permissionGrantId !== grant.permissionGrantId ||
        !snapshot.config.issuers.includes(provenance.issuerPrincipal) ||
        provenance.operatorConfigRevision !== snapshot.operatorConfigRevision ||
        provenance.operatorConfigDigest !== snapshot.operatorConfigDigest ||
        grant.issuer === principal
      ) {
        return Effect.fail(denyCommand(input, "DecideSandboxPolicy", "Denied"));
      }
      return Effect.succeed({
        _tag: "SandboxPolicyDecisionAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        workspaceId: episode.workspaceId,
        executionId: episode.executionId,
        episodeBinding: episode.episodeBinding,
        episodeRevision: episode.episodeRevision,
        permissionGrant: grant,
        issuerProvenance: provenance,
        authorityBundleRevision: snapshot.authorityBundleRevision,
        authorityBundleDigest: snapshot.authorityBundleDigest,
        providerRegistryRevision: snapshot.providerRegistryRevision,
        providerRegistryDigest: snapshot.providerRegistryDigest,
        operatorConfigRevision: snapshot.operatorConfigRevision,
        operatorConfigDigest: snapshot.operatorConfigDigest,
      });
    }
    case "RevokePermission": {
      const permissionGrantId = payloadString(
        payload,
        "permissionGrantId",
      ) as PermissionGrantId | null;
      const error = guarded("RevokePermission", permissionGrantId);
      if (error !== null || permissionGrantId === null) {
        return Effect.fail(
          error ?? denyCommand(input, "RevokePermission", "Denied"),
        );
      }
      return Effect.succeed({
        _tag: "RevokePermissionAuthority",
        principal,
        commandId,
        semanticRequestFingerprint,
        projectId,
        permissionGrantId,
      });
    }
    default:
      return Effect.fail({
        _tag: "UnsupportedOrigin",
        submissionOrigin: input.submissionContext._tag,
        commandType,
      });
  }
};

const resolve = (
  input: AuthorityDecisionInput,
): Effect.Effect<CommandAuthorityFact, AuthorityResolutionError, never> => {
  const commandType = input.envelope.commandType;
  if (commandType === "AdmitExecution" || commandType === "StopExecution") {
    if (input.submissionContext._tag !== "External") {
      return Effect.fail({
        _tag: "UnsupportedOrigin",
        submissionOrigin: input.submissionContext._tag,
        commandType,
      });
    }
    return externalRuntimeFact(input, commandType);
  }
  return governanceCommandFact(input);
};

const authorizeInvocation = (
  input: InvocationDecisionInput,
): Effect.Effect<ReadonlyArray<string>, InvocationResolutionError, never> => {
  const requested = input.intent.requestedCapabilities;
  const ceiling = readPolicyNumber(input.policy, "delegationCeiling", 0);
  if (input.executionRole !== "Verifier" && input.delegationDepth > ceiling) {
    return Effect.fail({
      _tag: "DelegationCeilingExceeded",
      delegationDepth: input.delegationDepth,
      ceiling,
    });
  }
  if (input.executionRole === "Verifier") {
    const verifierCapabilities = new Set(["fs:read", "shell:exec"]);
    const allowed = requested.filter((capability) =>
      verifierCapabilities.has(capability),
    );
    if (allowed.length !== requested.length) {
      return Effect.fail({
        _tag: "CapabilityCeilingExceeded",
        requested,
        allowed,
      });
    }
    return Effect.succeed(allowed);
  }
  if (isAuthenticatedHuman(input)) {
    return Effect.succeed([...requested]);
  }
  if (requested.every((capability) => capability === "fs:read")) {
    return Effect.succeed([...requested]);
  }
  const covered = new Set(input.workspaceAuthorizationCapabilities ?? []);
  if (requested.every((capability) => covered.has(capability))) {
    return Effect.succeed([...requested]);
  }
  if (input.grants.length === 0) {
    return Effect.fail({
      _tag: "NoApplicableGrant",
      principal: input.principal,
      toolName: input.intent.toolName,
    });
  }
  for (const requestedCapability of requested) {
    if (
      matchGrant(input.grants, requestedCapability, input.workspaceId, {
        principal: input.principal,
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        now: input.now,
      }) === "Match"
    ) {
      covered.add(requestedCapability);
    }
  }
  const allowed = requested.filter((capability) => covered.has(capability));
  if (allowed.length !== requested.length) {
    return Effect.fail({
      _tag: "CapabilityCeilingExceeded",
      requested,
      allowed,
    });
  }
  return Effect.succeed(allowed);
};

const resolveInvocation = (
  input: InvocationDecisionInput,
): Effect.Effect<InvocationAuthority, InvocationResolutionError, never> =>
  Effect.gen(function* () {
    const allowedCapabilities = yield* authorizeInvocation(input);
    const ttl = readPolicyNumber(input.policy, "authorityTtlSeconds", 900);
    return {
      principal: input.principal,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      toolName: input.intent.toolName,
      toolVersion: input.intent.toolVersion,
      resourceSpaceIds: input.intent.resolvedRegions,
      allowedCapabilities,
      controlBasisDigest: input.controlBasisDigest,
      expiresAt: addSeconds(input.now, ttl),
      delegationDepth: input.delegationDepth,
    };
  });

const deterministicApprovalId = (input: InvocationDecisionInput): string =>
  input.approvalIdentity === undefined
    ? [
        "apr",
        input.principal,
        input.workspaceId,
        input.executionId,
        input.intent.toolName,
        input.intent.toolVersion,
        input.intent.actionDigest,
        input.controlBasisDigest,
        input.intent.resolvedRegions.join(","),
      ].join(":")
    : [
        "eap",
        input.projectId ?? "unknown-project",
        input.executionId,
        input.approvalIdentity.logicalStepNo,
        input.approvalIdentity.repairAttempt,
        input.approvalIdentity.actionIndex,
        input.approvalIdentity.logicalActionId,
        input.approvalIdentity.callRef,
        input.approvalIdentity.toolInvocationId,
      ].join(":");

const resolveApproval = (
  input: InvocationDecisionInput,
): Effect.Effect<InvocationApproval, InvocationResolutionError, never> =>
  Effect.gen(function* () {
    yield* authorizeInvocation(input);
    const ttl = readPolicyNumber(input.policy, "authorityTtlSeconds", 900);
    return {
      approvalId: deterministicApprovalId(input),
      toolName: input.intent.toolName,
      toolVersion: input.intent.toolVersion,
      actionDigest: input.intent.actionDigest,
      targetResourceSpaceIds: input.intent.resolvedRegions,
      controlBasisDigest: input.controlBasisDigest,
      expiresAt: addSeconds(input.now, ttl),
      consumedBy: null,
    };
  });

export const AuthorityResolverPortLive: Layer.Layer<AuthorityResolverPort> =
  Layer.succeed(AuthorityResolverPort, {
    resolve,
    resolveInvocation,
    resolveApproval,
  });
