import type {
  CommandId,
  CommandSubmissionContext,
  ExecutionId,
  FormationProposalId,
  PermissionGrant,
  PermissionGrantId,
  PluginId,
  PluginVersion,
  Principal,
  ProjectId,
  ProjectPolicy,
  SemanticRequestFingerprint,
  VerificationId,
  WorkId,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import type { InvocationApproval, InvocationAuthority } from "@arbor/ports";
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
}

export interface CanonicalExecutionSnapshot {
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
}

export interface CanonicalWorkSnapshot {
  readonly workId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open" | "Completed" | "Cancelled";
}

export interface CanonicalAuthorityFacts {
  readonly projectId: ProjectId;
  readonly project?: { readonly rootWorkspaceId: WorkspaceId };
  readonly workspace?: CanonicalWorkspaceSnapshot;
  readonly execution?: CanonicalExecutionSnapshot;
  readonly work?: CanonicalWorkSnapshot;
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
}

/** P4 `03` §2/§4 invocation-scoped facts. `AuthorityDecisionInput` cannot
 * produce `InvocationAuthority` / `InvocationApproval` (N-03): those need the
 * resolved tool intent, the resolved regions, `controlBasisDigest`,
 * `expiresAt`, and `delegationDepth`, none of which a command envelope
 * carries. */
export interface InvocationDecisionInput {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly intent: {
    readonly toolName: string;
    readonly toolVersion: string;
    readonly argumentsJson: string;
    readonly actionDigest: string;
    readonly requestedCapabilities: ReadonlyArray<string>;
    readonly resolvedRegions: ReadonlyArray<string>;
  };
  readonly controlBasisDigest: string;
  readonly grants: ReadonlyArray<PermissionGrant>;
  readonly governance: ParentUserGovernanceFacts;
  readonly policy: ProjectPolicy | WorkspacePolicy;
  readonly delegationDepth: number;
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

interface ParsedGrantScope {
  readonly capability: string;
  readonly target: string | null;
}

const parseGrantScope = (scope: string): ParsedGrantScope => {
  const at = scope.indexOf("@");
  if (at < 0) {
    return { capability: scope, target: null };
  }
  const target = scope.slice(at + 1);
  return {
    capability: scope.slice(0, at),
    target: target.length > 0 ? target : null,
  };
};

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const payloadString = (payload: unknown, key: string): string | null => {
  const value = payloadRecord(payload)[key];
  return typeof value === "string" ? value : null;
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
): GrantMatch => {
  let wrongTarget = false;
  for (const grant of grants) {
    if (grant.state !== "Active") {
      continue;
    }
    const parsed = parseGrantScope(grant.scope);
    if (parsed.capability !== capability && parsed.capability !== "*") {
      continue;
    }
    if (parsed.target !== null && parsed.target !== target) {
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
  const match = matchGrant(input.grants, capability, target);
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
  const executionId = input.canonicalFacts.execution?.executionId ?? null;

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
  if (input.delegationDepth > ceiling) {
    return Effect.fail({
      _tag: "DelegationCeilingExceeded",
      delegationDepth: input.delegationDepth,
      ceiling,
    });
  }
  if (isAuthenticatedHuman(input)) {
    return Effect.succeed([...requested]);
  }
  const active = input.grants.filter((grant) => grant.state === "Active");
  if (active.length === 0) {
    return Effect.fail({
      _tag: "NoApplicableGrant",
      principal: input.principal,
      toolName: input.intent.toolName,
    });
  }
  const covered = new Set<string>();
  for (const grant of active) {
    const capability = parseGrantScope(grant.scope).capability;
    if (capability === "*") {
      for (const requestedCapability of requested) {
        covered.add(requestedCapability);
      }
    } else if (requested.includes(capability)) {
      covered.add(capability);
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
  [
    "apr",
    input.principal,
    input.workspaceId,
    input.executionId,
    input.intent.toolName,
    input.intent.toolVersion,
    input.intent.actionDigest,
    input.controlBasisDigest,
    input.intent.resolvedRegions.join(","),
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
