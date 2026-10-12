import {
  grantPermission,
  isIsoTimestamp,
  type PermissionGrantId,
  type PermissionGrantLifecycle,
  type PermissionSubject,
  type Principal,
} from "@arbor/domain";
import type {
  PendingDomainEvent,
  PermissionGrantRepositoryService,
} from "@arbor/ports";
import { Effect } from "effect";
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
}

export const makeGrantPermissionHandler = (
  dependencies: GrantPermissionDependencies,
): CommandHandler<GrantPermissionPayload, GrantPermissionResult> => ({
  commandType: "GrantPermission",
  schemaVersion: "1",
  authority: {
    tag: "GrantPermissionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "GrantPermissionAuthority" &&
      authority.permissionGrantId === payload.permissionGrantId,
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
        !Number.isFinite(issuedAt) ||
        expiresAt <= issuedAt
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
        validFrom: envelope.issuedAt,
        expiresAt: payload.expiresAt,
        revision: 0,
      });
      if (!created.ok) return commandErr(created.error);
      const grant = created.value;
      yield* dependencies.grants.put(grant, envelope.projectId);

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "PermissionChanged",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: grant.permissionGrantId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {},
        },
      ];

      return commandOk({
        result: {
          permissionGrantId: grant.permissionGrantId,
          state: grant.state,
        },
        events,
      });
    }),
});
