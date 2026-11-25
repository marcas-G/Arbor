export * from "./glob.js";
export * from "./grep.js";
export * from "./list.js";
export * from "./patch.js";
export * from "./read.js";
export * from "./shell.js";
export * from "./write.js";

import type { ToolExecutor } from "../runtime.js";
import { globExecutor } from "./glob.js";
import { grepExecutor } from "./grep.js";
import { listExecutor } from "./list.js";
import { patchExecutor } from "./patch.js";
import { readExecutor } from "./read.js";
import { shellExecutor } from "./shell.js";
import { writeExecutor } from "./write.js";

export const BUILTIN_EXECUTORS: ReadonlyArray<ToolExecutor> = [
  readExecutor,
  patchExecutor,
  shellExecutor,
  listExecutor,
  writeExecutor,
  globExecutor,
  grepExecutor,
];
