import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.js";
import { Button as UiButton } from "./ui/button.js";

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
  className,
  ...props
}: {
  readonly variant?: ButtonVariant | undefined;
  readonly type?: "button" | "submit" | undefined;
  readonly disabled?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  readonly className?: string | undefined;
  readonly children: ReactNode;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className" | "disabled" | "onClick" | "type"
>) {
  const inert = disabled || loading;
  return (
    <UiButton
      variant={variant}
      type={type}
      disabled={inert}
      onClick={inert ? undefined : onClick}
      loading={loading}
      className={cx(["arbor-button", `arbor-button-${variant}`, className])}
      {...props}
    >
      {children}
    </UiButton>
  );
}
