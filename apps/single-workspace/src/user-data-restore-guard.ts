import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const RESTORE_INCOMPLETE_MARKER = ".arbor-restore-incomplete";

export const assertNoIncompleteRestore = (databaseFile: string): void => {
  if (
    databaseFile !== ":memory:" &&
    existsSync(join(dirname(resolve(databaseFile)), RESTORE_INCOMPLETE_MARKER))
  ) {
    throw new Error(
      "Arbor data restore is incomplete; use a new empty directory to restore again.",
    );
  }
};
