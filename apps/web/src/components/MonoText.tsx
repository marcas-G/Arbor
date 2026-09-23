import type { ReactNode } from "react";
import { cx } from "./cx.js";
import styles from "./MonoText.module.css";

/** W-01 MonoText: monospaced run for IDs / vocabulary / data. */
export function MonoText({ children }: { readonly children: ReactNode }) {
  return <span className={cx(["arbor-mono", styles.mono])}>{children}</span>;
}
