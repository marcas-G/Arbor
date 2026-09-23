/** Join class-name parts, skipping falsy values (CSS module access can be
 * undefined under stubbed test transforms). */
export function cx(
  parts: ReadonlyArray<string | false | null | undefined>,
): string {
  return parts.filter((part) => typeof part === "string").join(" ");
}
