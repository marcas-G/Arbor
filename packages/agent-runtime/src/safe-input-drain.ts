import type { InboxEntry } from "@arbor/domain";

export interface PendingInputPromotion {
  readonly entry: InboxEntry;
  readonly delivery: "Steer" | "Queue";
}

/** SCRC-003: Steer is admitted at every safe sampling boundary. Queue input
 * never interrupts a continuation; only the first queued item is admitted at
 * the start of a fresh drain, then continuation is re-evaluated. */
export const selectPendingInputPromotions = (
  entries: ReadonlyArray<InboxEntry>,
  options: { readonly freshDrain: boolean },
): ReadonlyArray<PendingInputPromotion> => {
  const steer = entries
    .filter((entry) => entry.kind === "HumanInput")
    .map((entry) => ({ entry, delivery: "Steer" as const }));
  if (!options.freshDrain) return steer;
  const queued = entries.find((entry) => entry.kind !== "HumanInput");
  return queued === undefined
    ? steer
    : [...steer, { entry: queued, delivery: "Queue" as const }];
};
