import {
  grantPermission,
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
  readonly target: string | null;
  readonly expiresAt: string | null;
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
      const subjectValid =
        (payload.subject._tag === "HumanPrincipal" &&
          payload.subject.principal.startsWith("user:")) ||
        (payload.subject._tag === "WorkspaceAgent" &&
          payload.subject.workspaceId.startsWith("ws_")) ||
        (payload.subject._tag === "Execution" &&
          payload.subject.executionId.startsWith("exe_"));
      if (
        !subjectValid ||
        payload.capability.trim().length === 0 ||
        payload.issuer !== context.principal ||
        (payload.expiresAt !== null &&
          Date.parse(payload.expiresAt) <= Date.parse(envelope.issuedAt))
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "GrantPermission requires an exact subject, non-empty capability, issuer=current principal, and future expiry",
        });
      }
      const grant = grantPermission({
        permissionGrantId: payload.permissionGrantId,
        scope:
          payload.target === null
            ? payload.capability
            : `${payload.capability}@${payload.target}`,
        issuer: payload.issuer,
        lifetime: payload.expiresAt ?? "until-revoked",
        subject: payload.subject,
        capability: payload.capability,
        target: payload.target,
        validFrom: envelope.issuedAt,
        expiresAt: payload.expiresAt,
        revision: 0,
      });
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
