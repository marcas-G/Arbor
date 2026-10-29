import type { WorkId } from "./ids.js";
import type { WorkRevision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

/** @deprecated DID v1.31 MAC-D1 compatibility only. Active code uses the
 * Runtime/Cognition LocalPlan contract from @arbor/ports and
 * @arbor/agent-runtime. */

export type PlanItemStatus = "Pending" | "InProgress" | "Completed" | "Blocked";

export interface PlanItem {
  readonly itemId: string;
  readonly text: string;
  readonly status: PlanItemStatus;
}

/** DID v1.28 EGP — model-maintained progress state. Never an authority or a
 * second Work lifecycle. */
export interface WorkPlan {
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly planRevision: number;
  readonly items: ReadonlyArray<PlanItem>;
  readonly updatedAt: string;
}

export const reviseWorkPlan = (input: {
  readonly current: WorkPlan | null;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly expectedPlanRevision: number;
  readonly items: ReadonlyArray<PlanItem>;
  readonly updatedAt: string;
}): DomainResult<WorkPlan> => {
  const currentRevision = input.current?.planRevision ?? 0;
  if (input.expectedPlanRevision !== currentRevision) {
    return err({
      _tag: "RevisionConflict",
      expected: input.expectedPlanRevision,
      actual: currentRevision,
    });
  }
  if (input.items.length === 0) {
    return err({
      _tag: "WorkPlanInvalid",
      reason: "plan items must be non-empty",
    });
  }
  const ids = new Set<string>();
  for (const item of input.items) {
    if (item.itemId.trim().length === 0 || item.text.trim().length === 0) {
      return err({
        _tag: "WorkPlanInvalid",
        reason: "plan item id and text must be non-empty",
      });
    }
    if (ids.has(item.itemId)) {
      return err({ _tag: "WorkPlanInvalid", reason: "duplicate plan item id" });
    }
    ids.add(item.itemId);
  }
  return ok({
    workId: input.workId,
    targetWorkRevision: input.targetWorkRevision,
    planRevision: currentRevision + 1,
    items: input.items,
    updatedAt: input.updatedAt,
  });
};
