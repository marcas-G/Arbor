import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// These aliases are defined in styles/tailwind.css. Without this extension,
// text-small is mistaken for a color and removed by text-foreground.
const mergeUtilities = extendTailwindMerge({
  extend: {
    theme: {
      text: ["body", "small", "caption", "title", "display"],
      spacing: ["ui-1", "ui-2", "ui-3", "ui-4", "ui-5", "ui-6"],
      shadow: ["card", "float"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeUtilities(clsx(inputs));
}
