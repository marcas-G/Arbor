import type { ReactNode } from "react";
import type { Tone } from "../tokens.js";

export function Badge({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return <span className={`arbor-badge arbor-badge-${tone}`}>{children}</span>;
}
