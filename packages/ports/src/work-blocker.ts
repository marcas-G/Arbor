import type { Sha256, WorkBlocker, WorkId, WorkRevision } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { WorkBlockerStoreError } from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface ResolveWorkBlockerInput {
  readonly blockerId: Sha256;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly successfulActionRefs: readonly [string, ...ReadonlyArray<string>];
}

export interface WorkBlockerStoreService {
  readonly findById: (
    blockerId: WorkBlocker["blockerId"],
  ) => Effect.Effect<
    Option.Option<WorkBlocker>,
    WorkBlockerStoreError,
    TransactionScope
  >;
  readonly listByWorkRevision: (
    workId: WorkId,
    targetWorkRevision: WorkRevision,
  ) => Effect.Effect<
    ReadonlyArray<WorkBlocker>,
    WorkBlockerStoreError,
    TransactionScope
  >;
  /** Upsert one deterministic blocker identity; exact replay is idempotent. */
  readonly openOrUpdate: (
    blocker: WorkBlocker,
  ) => Effect.Effect<WorkBlocker, WorkBlockerStoreError, TransactionScope>;
  readonly resolve: (
    input: ResolveWorkBlockerInput,
  ) => Effect.Effect<void, WorkBlockerStoreError, TransactionScope>;
  readonly supersede: (
    workId: WorkId,
    targetWorkRevision: WorkRevision,
  ) => Effect.Effect<void, WorkBlockerStoreError, TransactionScope>;
}

export class WorkBlockerStore extends Context.Service<
  WorkBlockerStore,
  WorkBlockerStoreService
>()("arbor/WorkBlockerStore") {}
