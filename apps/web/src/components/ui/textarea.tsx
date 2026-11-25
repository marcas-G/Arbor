import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
import { inputClassName } from "./input.js";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(inputClassName, "resize-y", className)}
      {...props}
    />
  );
}
