import {
  grantPermission,
  type PermissionGrantId,
  type PermissionGrantLifecycle,
  type Principal,
} from "@arbor/domain";
import type {
  PendingDomainEvent,
  PermissionGrantRepositoryService,
} from "@arbor/ports";
import { Effect } from "effect";
import { commandOk } from "../command-result.js";
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
  readonly scope: string;
  readonly issuer: Principal;
  readonly lifetime: string;
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
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const grant = grantPermission({
        permissionGrantId: payload.permissionGrantId,
        scope: payload.scope,
        issuer: payload.issuer,
        lifetime: payload.lifetime,
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
