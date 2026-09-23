import type { ReactNode } from "react";
import type { Tone } from "../tokens.js";
import styles from "./Badge.module.css";
import { cx } from "./cx.js";

/** W-01 formal Badge. Global `arbor-badge-*` classes stay as the stable
 * styling/test contract; module classes add the formal refinements. */
export function Badge({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cx([
        "arbor-badge",
        `arbor-badge-${tone}`,
        styles.badge,
        styles[`tone-${tone}`],
      ])}
    >
      {children}
    </span>
  );
}
