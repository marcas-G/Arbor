import type { WorkId, WorkRevision } from "@arbor/domain";
import type { LocalPlan, LocalPlanItem } from "@arbor/ports";

export type LocalPlanRevisionError =
  | {
      readonly _tag: "LocalPlanRevisionConflict";
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly _tag: "LocalPlanInvalid"; readonly reason: string };

export type LocalPlanRevisionResult =
  | { readonly ok: true; readonly value: LocalPlan }
  | { readonly ok: false; readonly error: LocalPlanRevisionError };

/** MAC-D1: pure cognition transition. It deliberately returns its own
 * Runtime error algebra instead of participating in DomainError. */
export const reviseLocalPlan = (input: {
  readonly current: LocalPlan | null;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly expectedRevision: number;
  readonly items: ReadonlyArray<LocalPlanItem>;
  readonly updatedAt: string;
}): LocalPlanRevisionResult => {
  const currentRevision = input.current?.revision ?? 0;
  if (input.expectedRevision !== currentRevision) {
    return {
      ok: false,
      error: {
        _tag: "LocalPlanRevisionConflict",
        expected: input.expectedRevision,
        actual: currentRevision,
      },
    };
  }
  if (input.items.length === 0) {
    return {
      ok: false,
      error: {
        _tag: "LocalPlanInvalid",
        reason: "plan items must be non-empty",
      },
    };
  }
  const ids = new Set<string>();
  for (const item of input.items) {
    if (item.itemId.trim().length === 0 || item.text.trim().length === 0) {
      return {
        ok: false,
        error: {
          _tag: "LocalPlanInvalid",
          reason: "plan item id and text must be non-empty",
        },
      };
    }
    if (ids.has(item.itemId)) {
      return {
        ok: false,
        error: { _tag: "LocalPlanInvalid", reason: "duplicate plan item id" },
      };
    }
    ids.add(item.itemId);
  }
  return {
    ok: true,
    value: {
      workId: input.workId,
      targetWorkRevision: input.targetWorkRevision,
      revision: currentRevision + 1,
      items: input.items,
      updatedAt: input.updatedAt,
    },
  };
};
