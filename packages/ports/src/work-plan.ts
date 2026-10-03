import type { WorkId, WorkRevision } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { LocalPlanStoreError } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type LocalPlanItemStatus =
  | "Pending"
  | "InProgress"
  | "Completed"
  | "Blocked";

export interface LocalPlanItem {
  readonly itemId: string;
  readonly text: string;
  readonly status: LocalPlanItemStatus;
}

/** MAC-D1: recoverable Workspace cognition for one exact Work revision.
 * This record has no Domain authority or scheduling/completion semantics. */
export interface LocalPlan {
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly revision: number;
  readonly items: ReadonlyArray<LocalPlanItem>;
  readonly updatedAt: string;
}

export interface LocalPlanStoreService {
  readonly findByWork: (
    workId: WorkId,
  ) => Effect.Effect<
    Option.Option<LocalPlan>,
    LocalPlanStoreError,
    TransactionScope
  >;
  readonly save: (
    plan: LocalPlan,
    expectedRevision: number,
  ) => Effect.Effect<void, LocalPlanStoreError, TransactionScope>;
}

export class LocalPlanStore extends Context.Service<
  LocalPlanStore,
  LocalPlanStoreService
>()("arbor/LocalPlanStore") {}
