import type { ReactNode } from "react";
import type { Tone } from "../tokens.js";
import { Badge as UiBadge } from "./ui/badge.js";
export function Badge({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return (
    <UiBadge tone={tone} className={`arbor-badge arbor-badge-${tone}`}>
      {children}
    </UiBadge>
  );
}
