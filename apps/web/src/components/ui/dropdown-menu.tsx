import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 8,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[1001] min-w-44 max-w-[calc(100vw-1rem)] rounded-md border border-solid border-border bg-popover p-1 text-popover-foreground shadow-float outline-none",
          className,
        )}
        {...props}
      />
    </DropdownPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownPrimitive.Item>) {
  return (
    <DropdownPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex min-h-[var(--arbor-row-height)] cursor-pointer items-center rounded-sm px-3 py-2 text-small outline-none data-[highlighted]:bg-accent data-[highlighted]:text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
