import type { ReactNode } from "react";
import { cx } from "./cx.js";

/** W-01 MonoText: monospaced run for IDs / vocabulary / data. */
export function MonoText({ children }: { readonly children: ReactNode }) {
  return (
    <span className={cx(["arbor-mono", "font-mono text-small"])}>
      {children}
    </span>
  );
}
