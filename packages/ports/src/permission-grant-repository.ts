import type {
  PermissionGrant,
  PermissionGrantId,
  ProjectId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { TransactionScope } from "./session.js";

/**
 * P12 `02` §5.1 (R-08, M4): the durable `PermissionGrant` store.
 *
 * This is the frozen DID §7.2 catalog name `PermissionGrantRepository`
 * (C9 ownership row) — not a new catalog surface.
 *
 * CI-1 caller restriction (M5): `put` / `revoke` are durable canonical
 * writes. They are invocable **only** by the `GrantPermission` /
 * `RevokePermission` handlers inside the `CommandGateway` transaction; the
 * resolver only *reads* via `activeGrants` and has `R = never`. No other
 * caller (resolver, composition root, adapter) may invoke them.
 */
export type PermissionGrantRepositoryError =
  | {
      readonly _tag: "PermissionGrantNotFound";
      readonly permissionGrantId: PermissionGrantId;
    }
  | {
      readonly _tag: "PermissionGrantRepositoryFailure";
      readonly cause: unknown;
    };

export interface PermissionGrantRepositoryService {
  /** Active grants only (`state = 'Active'`); a Revoked grant is never loaded. */
  readonly activeGrants: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<PermissionGrant>,
    PermissionGrantRepositoryError,
    TransactionScope
  >;
  readonly put: (
    grant: PermissionGrant,
    projectId: ProjectId,
  ) => Effect.Effect<void, PermissionGrantRepositoryError, TransactionScope>;
  readonly revoke: (
    permissionGrantId: PermissionGrantId,
  ) => Effect.Effect<void, PermissionGrantRepositoryError, TransactionScope>;
}

export class PermissionGrantRepository extends Context.Service<
  PermissionGrantRepository,
  PermissionGrantRepositoryService
>()("arbor/PermissionGrantRepository") {}
