import type { ReactNode } from "react";

export type ButtonVariant = "primary" | "quiet" | "danger";

export function Button({
  variant = "quiet",
  type = "button",
  disabled = false,
  onClick,
  children,
}: {
  readonly variant?: ButtonVariant | undefined;
  readonly type?: "button" | "submit" | undefined;
  readonly disabled?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`arbor-button arbor-button-${variant}`}
    >
      {children}
    </button>
  );
}
