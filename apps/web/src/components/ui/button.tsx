import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex min-h-[var(--arbor-row-height)] cursor-pointer items-center justify-center gap-2 rounded-sm border border-solid px-3 py-1 font-sans text-small font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "border-primary bg-primary text-primary-foreground hover:border-accent-foreground hover:bg-accent-foreground",
        quiet:
          "border-transparent bg-transparent text-primary hover:border-border hover:bg-accent hover:text-accent-foreground",
        danger: "border-destructive bg-destructive text-primary-foreground",
      },
    },
    defaultVariants: { variant: "quiet" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, loading = false, disabled, children, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading}
      className={cn(
        buttonVariants({ variant }),
        className,
        loading && "after:ml-1 after:content-['…']",
      )}
      {...props}
    >
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export { buttonVariants };
