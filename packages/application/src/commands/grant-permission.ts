import {
  ExecutionId,
  grantPermission,
  isIsoTimestamp,
  type PermissionGrantId,
  type PermissionGrantLifecycle,
  type PermissionSubject,
  type Principal,
  parse,
  type SandboxPolicyGrantIssuerConfigSnapshotV1,
} from "@arbor/domain";
import type {
  ClockService,
  ExecutionRepositoryService,
  PendingDomainEvent,
  PermissionGrantRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/**
 * P12 `02` §5 (G2): the `GrantPermission` governance command.
 *
 * `GrantPermission` / `RevokePermission` are the only durable writers of the
 * grant store (CI-1): the handler writes through the `PermissionGrantRepository`
 * port inside the command gateway transaction and emits `PermissionChanged`.
 * The resolver only reads active grants; it never writes.
 */
export interface GrantPermissionPayload {
  readonly permissionGrantId: PermissionGrantId;
  readonly issuer: Principal;
  readonly subject: PermissionSubject;
  readonly capability: string;
  readonly target: string;
  readonly expiresAt: string;
}

export interface GrantPermissionResult {
  readonly permissionGrantId: PermissionGrantId;
  readonly state: PermissionGrantLifecycle;
}

export interface GrantPermissionDependencies {
  readonly grants: PermissionGrantRepositoryService;
  readonly executions?: Pick<ExecutionRepositoryService, "findById">;
  readonly clock?: Pick<ClockService, "now">;
  readonly sandboxPolicyGrantIssuerConfigSnapshot?: SandboxPolicyGrantIssuerConfigSnapshotV1;
}

export const makeGrantPermissionHandler = (
  dependencies: GrantPermissionDependencies,
): CommandHandler<GrantPermissionPayload, GrantPermissionResult> => ({
  commandType: "GrantPermission",
  schemaVersion: "1",
  authority: {
    tag: "GrantPermissionAuthority",
    targetMatches: (authority, payload) => {
      if (
        authority._tag !== "GrantPermissionAuthority" ||
        authority.permissionGrantId !== payload.permissionGrantId
      ) {
        return false;
      }
      return payload.capability === "DecideSandboxPolicy"
        ? authority.sandboxPolicyIssuerBinding?.executionId === payload.target
        : authority.sandboxPolicyIssuerBinding === undefined;
    },
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const target = typeof payload.target === "string" ? payload.target : "";
      const capability =
        typeof payload.capability === "string" ? payload.capability : "";
      const expiresAtText =
        typeof payload.expiresAt === "string" ? payload.expiresAt : "";
      const expiresAt = isIsoTimestamp(expiresAtText)
        ? Date.parse(expiresAtText)
        : Number.NaN;
      const issuedAt = isIsoTimestamp(envelope.issuedAt)
        ? Date.parse(envelope.issuedAt)
        : Number.NaN;
      const sandboxPolicyCapability = capability === "DecideSandboxPolicy";
      let trustedNow: string | undefined;
      let sandboxExecutionId: ExecutionId | undefined;
      let sandboxAuthorityBinding:
        | {
            readonly executionId: ExecutionId;
            readonly operatorConfigRevision: number;
            readonly operatorConfigDigest: string;
          }
        | undefined;
      if (sandboxPolicyCapability) {
        const authority = envelope.resolvedAuthority;
        const snapshot = dependencies.sandboxPolicyGrantIssuerConfigSnapshot;
        if (
          dependencies.executions === undefined ||
          dependencies.clock === undefined ||
          snapshot === undefined ||
          authority?._tag !== "GrantPermissionAuthority" ||
          authority.sandboxPolicyIssuerBinding === undefined
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "sandbox policy issuer authority is unavailable",
          });
        }
        const issuerBinding = authority.sandboxPolicyIssuerBinding;
        if (
          issuerBinding.operatorConfigRevision !== snapshot.config.revision ||
          issuerBinding.operatorConfigDigest !== snapshot.configDigest ||
          issuerBinding.authorityBundleRevision !==
            snapshot.authorityBundleRevision ||
          issuerBinding.authorityBundleDigest !==
            snapshot.authorityBundleDigest ||
          issuerBinding.providerRegistryRevision !==
            snapshot.providerRegistryRevision ||
          issuerBinding.providerRegistryDigest !==
            snapshot.providerRegistryDigest ||
          !snapshot.config.issuers.includes(context.principal) ||
          payload.issuer !== context.principal ||
          payload.subject._tag !== "HumanPrincipal" ||
          payload.subject.principal === context.principal ||
          !Number.isFinite(expiresAt)
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "sandbox policy grant binding is invalid",
          });
        }
        try {
          sandboxExecutionId = parse(ExecutionId)(target);
        } catch {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "sandbox policy grant target is invalid",
          });
        }
        if (sandboxExecutionId !== issuerBinding.executionId) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "sandbox policy grant target changed",
          });
        }
        trustedNow = yield* dependencies.clock.now();
        const currentExecution =
          yield* dependencies.executions.findById(sandboxExecutionId);
        if (
          !isIsoTimestamp(trustedNow) ||
          expiresAt <= Date.parse(trustedNow) ||
          !Option.isSome(currentExecution) ||
          currentExecution.value.projectId !== envelope.projectId ||
          currentExecution.value.state.status !== "Active"
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason: "sandbox policy grant execution or lifetime changed",
          });
        }
        sandboxAuthorityBinding = issuerBinding;
      }
      const subjectValid =
        (payload.subject._tag === "HumanPrincipal" &&
          payload.subject.principal.startsWith("user:")) ||
        (payload.subject._tag === "WorkspaceAgent" &&
          payload.subject.workspaceId.startsWith("ws_")) ||
        (payload.subject._tag === "Execution" &&
          payload.subject.executionId.startsWith("exe_"));
      if (
        !subjectValid ||
        capability.length === 0 ||
        capability !== capability.trim() ||
        target.length === 0 ||
        target !== target.trim() ||
        payload.issuer !== context.principal ||
        !Number.isFinite(expiresAt) ||
        (!sandboxPolicyCapability && !Number.isFinite(issuedAt)) ||
        expiresAt <=
          (trustedNow === undefined ? issuedAt : Date.parse(trustedNow))
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "GrantPermission requires an exact subject, capability, target, issuer=current principal, and future expiry",
        });
      }
      const created = grantPermission({
        permissionGrantId: payload.permissionGrantId,
        scope: `${capability}@${target}`,
        issuer: payload.issuer,
        lifetime: payload.expiresAt,
        subject: payload.subject,
        capability,
        target,
        validFrom: trustedNow ?? envelope.issuedAt,
        expiresAt: payload.expiresAt,
        revision: 0,
      });
      if (!created.ok) return commandErr(created.error);
      const grant = created.value;
      yield* dependencies.grants.put(grant, envelope.projectId);
      if (sandboxAuthorityBinding !== undefined) {
        yield* dependencies.grants.insertSandboxPolicyGrantIssuerProvenance({
          permissionGrantId: grant.permissionGrantId,
          grantPermissionCommandId: envelope.commandId,
          issuerPrincipal: payload.issuer,
          operatorConfigRevision:
            sandboxAuthorityBinding.operatorConfigRevision,
          operatorConfigDigest: sandboxAuthorityBinding.operatorConfigDigest,
        });
      }

      const occurredAt = trustedNow ?? envelope.issuedAt;
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "PermissionChanged",
          eventVersion: 1,
          occurredAt,
          aggregateRef: grant.permissionGrantId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {},
        },
      ];
      if (
        sandboxAuthorityBinding !== undefined &&
        sandboxExecutionId !== undefined
      ) {
        events.push({
          projectId: envelope.projectId,
          eventType: "SandboxPolicyGrantIssued",
          eventVersion: 1,
          occurredAt,
          aggregateRef: grant.permissionGrantId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            permissionGrantId: grant.permissionGrantId,
            grantPermissionCommandId: envelope.commandId,
            executionId: sandboxExecutionId,
            operatorConfigRevision:
              sandboxAuthorityBinding.operatorConfigRevision,
            operatorConfigDigest: sandboxAuthorityBinding.operatorConfigDigest,
          },
        });
      }

      return commandOk({
        result: {
          permissionGrantId: grant.permissionGrantId,
          state: grant.state,
        },
        events,
      });
    }),
});
