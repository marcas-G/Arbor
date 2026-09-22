import {
  type PermissionGrantId,
  type PermissionGrantLifecycle,
  revokePermission,
} from "@arbor/domain";
import type {
  PendingDomainEvent,
  PermissionGrantRepositoryError,
  PermissionGrantRepositoryService,
} from "@arbor/ports";
import { Effect } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/**
 * P12 `02` §5 (G2): the `RevokePermission` governance command.
 *
 * The domain transition is the frozen P0 `revokePermission` (Active ->
 * Revoked; reactivating a Revoked grant is illegal, DID §12.11). The durable
 * write goes only through the `PermissionGrantRepository` port inside the
 * command gateway transaction (CI-1), emitting `PermissionChanged`.
 */
export interface RevokePermissionPayload {
  readonly permissionGrantId: PermissionGrantId;
}

export interface RevokePermissionResult {
  readonly permissionGrantId: PermissionGrantId;
  readonly state: PermissionGrantLifecycle;
}

export interface RevokePermissionDependencies {
  readonly grants: PermissionGrantRepositoryService;
}

export const makeRevokePermissionHandler = (
  dependencies: RevokePermissionDependencies,
): CommandHandler<RevokePermissionPayload, RevokePermissionResult> => ({
  commandType: "RevokePermission",
  schemaVersion: "1",
  authority: {
    tag: "RevokePermissionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "RevokePermissionAuthority" &&
      authority.permissionGrantId === payload.permissionGrantId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const active = yield* dependencies.grants.activeGrants(
        envelope.projectId,
      );
      const existing = active.find(
        (grant) => grant.permissionGrantId === payload.permissionGrantId,
      );
      if (existing === undefined) {
        return yield* Effect.fail<PermissionGrantRepositoryError>({
          _tag: "PermissionGrantNotFound",
          permissionGrantId: payload.permissionGrantId,
        });
      }
      const revoked = revokePermission(existing, { authorized: true });
      if (!revoked.ok) {
        return commandErr(revoked.error);
      }
      yield* dependencies.grants.revoke(payload.permissionGrantId);

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "PermissionChanged",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: revoked.value.permissionGrantId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {},
        },
      ];

      return commandOk({
        result: {
          permissionGrantId: revoked.value.permissionGrantId,
          state: revoked.value.state,
        },
        events,
      });
    }),
});
