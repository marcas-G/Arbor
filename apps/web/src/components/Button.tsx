import type { ReactNode } from "react";
import styles from "./Button.module.css";
import { cx } from "./cx.js";

export type ButtonVariant = "primary" | "quiet" | "danger";

/** W-01 formal Button. `loading` disables interaction and marks the control
 * busy; `type` is passed through (default "button"). */
export function Button({
  variant = "quiet",
  type = "button",
  disabled = false,
  loading = false,
  onClick,
  children,
}: {
  readonly variant?: ButtonVariant | undefined;
  readonly type?: "button" | "submit" | undefined;
  readonly disabled?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  const inert = disabled || loading;
  return (
    <button
      type={type}
      disabled={inert}
      aria-busy={loading}
      onClick={inert ? undefined : onClick}
      className={cx([
        "arbor-button",
        `arbor-button-${variant}`,
        styles.button,
        loading ? styles.loading : undefined,
      ])}
    >
      {children}
    </button>
  );
}
