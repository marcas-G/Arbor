import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const escapesRoot = (relativePath: string): boolean =>
  relativePath === ".." ||
  relativePath.startsWith(`..${sep}`) ||
  isAbsolute(relativePath);

/** Resolve an existing path through lexical and real filesystem boundaries.
 * Both checks are required: relative traversal breaks the lexical boundary,
 * while symlinks/junctions can escape only after realpath resolution. */
export const resolveExistingWithin = (
  root: string,
  requestedPath: string,
): string => {
  if (isAbsolute(requestedPath)) {
    throw new Error("absolute paths are not allowed");
  }
  const realRoot = realpathSync(resolve(root));
  const lexicalTarget = resolve(realRoot, requestedPath);
  if (escapesRoot(relative(realRoot, lexicalTarget))) {
    throw new Error("path escapes sandbox root");
  }
  const realTarget = realpathSync(lexicalTarget);
  if (escapesRoot(relative(realRoot, realTarget))) {
    throw new Error("path resolves outside sandbox root");
  }
  return realTarget;
};
