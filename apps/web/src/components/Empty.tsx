import type { ReactNode } from "react";
import { Button } from "./Button.js";
import { cx } from "./cx.js";
import styles from "./Empty.module.css";

/** Structured action (W-01 formal API): renders as a quiet Button. */
export type EmptyAction = {
  readonly label: string;
  readonly onClick: () => void;
};

function isEmptyAction(value: ReactNode | EmptyAction): value is EmptyAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly $$typeof?: unknown } & EmptyAction;
  if (typeof candidate.$$typeof === "symbol") {
    return false;
  }
  return (
    typeof candidate.label === "string" &&
    typeof candidate.onClick === "function"
  );
}

/** W-01 formal Empty: quiet empty-state block. `action` accepts the
 * structured `{label, onClick}` form (rendered as a Button) or a plain
 * ReactNode (legacy ProblemCard usage). */
export function Empty({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode | EmptyAction | undefined;
}) {
  return (
    <div className={cx(["arbor-empty", styles.empty])}>
      <span className={cx(["arbor-empty-text", styles.text])}>{children}</span>
      {action === undefined ? null : (
        <div className={cx(["arbor-empty-action", styles.action])}>
          {isEmptyAction(action) ? (
            <Button variant="quiet" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : (
            action
          )}
        </div>
      )}
    </div>
  );
}
