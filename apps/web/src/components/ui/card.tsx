import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "overflow-hidden rounded-md border border-solid border-border bg-card text-card-foreground shadow-card",
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      data-slot="card-header"
      className={cn(
        "flex items-center justify-between gap-3 border-0 border-b border-solid border-border bg-background/45 px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("m-0 text-title font-semibold tracking-tight", className)}
      {...props}
    />
  );
}
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("p-5", className)} {...props} />
  );
}
