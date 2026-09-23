import type { ReactNode } from "react";

export function Empty({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode | undefined;
}) {
  return (
    <div className="arbor-empty">
      <span className="arbor-empty-text">{children}</span>
      {action === undefined ? null : (
        <div className="arbor-empty-action">{action}</div>
      )}
    </div>
  );
}
