import { cn } from "../lib/utils.js";
/** Compose utility recipes and resolve caller overrides. */
export function cx(
  parts: ReadonlyArray<string | false | null | undefined>,
): string {
  return cn(...parts);
}
