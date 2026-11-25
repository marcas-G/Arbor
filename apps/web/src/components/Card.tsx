import type { ReactNode } from "react";
import {
  CardContent,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "./ui/card.js";

/** W-01 formal Card: optional `title` on the left, optional `actions` on
 * the right of the header row. */
export function Card({
  title,
  actions,
  children,
}: {
  readonly title?: string | undefined;
  readonly actions?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <UiCard className="arbor-card">
      {hasHeader ? (
        <CardHeader className="arbor-card-header">
          {title === undefined ? null : (
            <CardTitle className="arbor-card-title">{title}</CardTitle>
          )}
          {actions === undefined ? null : (
            <div className="flex items-center gap-ui-2">{actions}</div>
          )}
        </CardHeader>
      ) : null}
      <CardContent className="arbor-card-body">{children}</CardContent>
    </UiCard>
  );
}
