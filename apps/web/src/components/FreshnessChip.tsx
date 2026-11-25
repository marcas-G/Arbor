import type { Tone } from "../tokens.js";
import { Badge } from "./Badge.js";

export type FreshnessState = "fresh" | "stale" | "offline";

const FRESHNESS: Readonly<
  Record<FreshnessState, { tone: Tone; label: string }>
> = {
  fresh: { tone: "leaf", label: "实时" },
  stale: { tone: "attention", label: "滞后" },
  offline: { tone: "muted", label: "离线" },
};

/** W-01 FreshnessChip: view freshness indicator — 实时 / 滞后 / 离线. */
export function FreshnessChip({ state }: { readonly state: FreshnessState }) {
  const meta = FRESHNESS[state];
  return (
    <span className={"inline-flex items-center"}>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </span>
  );
}
