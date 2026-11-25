import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export const inputClassName =
  "min-h-[var(--arbor-row-height)] w-full min-w-0 rounded-sm border border-solid border-input bg-card px-3 py-2 font-sans text-body text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(inputClassName, className)}
      {...props}
    />
  );
}
