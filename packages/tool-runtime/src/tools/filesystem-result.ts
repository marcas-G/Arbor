import { bounded, type ToolExecutionResult } from "../runtime.js";

/**
 * Filesystem validation and I/O failures are expected tool outcomes. They must
 * not become Effect defects: a malformed, stale, missing, or escaping target
 * is model-visible failure, while genuine process crashes remain available to
 * the recovery runtime as defects.
 */
export const executeFilesystemTool = (
  operation: () => ToolExecutionResult,
): ToolExecutionResult => {
  try {
    return operation();
  } catch {
    return {
      settlement: { _tag: "ExpectedFailure" },
      observation: bounded(
        "filesystem target could not be resolved or accessed inside the sandbox",
      ),
      resultRef: null,
    };
  }
};
