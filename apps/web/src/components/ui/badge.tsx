import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center p-[0_var(--arbor-space-2)] border border-solid border-[transparent] rounded-full font-sans text-caption [font-weight:650] leading-[1.7] whitespace-nowrap tracking-[0.04em] uppercase",
  {
    variants: {
      tone: {
        leaf: "text-primary border-primary bg-accent",
        attention:
          "text-attention border-[color-mix(in_srgb,_var(--arbor-attention)_30%,_transparent)] bg-[color-mix(in_srgb,_var(--arbor-attention)_9%,_transparent)]",
        danger:
          "text-destructive border-[color-mix(in_srgb,_var(--arbor-danger)_28%,_transparent)] bg-[color-mix(in_srgb,_var(--arbor-danger)_8%,_transparent)]",
        muted: "text-subtle border-border",
        branch: "text-branch border-branch",
        sky: "text-sky border-sky",
      },
    },
    defaultVariants: { tone: "muted" },
  },
);
export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
}
