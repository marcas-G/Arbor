export * from "./patch.js";
export * from "./read.js";
export * from "./shell.js";

import type { ToolExecutor } from "../runtime.js";
import { patchExecutor } from "./patch.js";
import { readExecutor } from "./read.js";
import { shellExecutor } from "./shell.js";

export const BUILTIN_EXECUTORS: ReadonlyArray<ToolExecutor> = [
  readExecutor,
  patchExecutor,
  shellExecutor,
];
