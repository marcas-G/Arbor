import type { Tone } from "../tokens.js";
import { Badge } from "./Badge.js";
import styles from "./FreshnessChip.module.css";

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
    <span className={styles.chip}>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </span>
  );
}
