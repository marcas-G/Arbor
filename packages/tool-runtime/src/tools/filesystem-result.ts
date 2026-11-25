import { bounded, type ToolExecutionResult } from "../runtime.js";

/**
 * Filesystem validation and I/O failures are expected tool outcomes. They must
 * not become Effect defects: a malformed, stale, missing, or escaping target
 * is model-visible failure, while genuine process crashes remain available to
 * the recovery runtime as defects.
 */
export const executeFilesystemTool = (
  operation: () => ToolExecutionResult,
  onFailure?: () => ToolExecutionResult | undefined,
): ToolExecutionResult => {
  try {
    return operation();
  } catch {
    const outcome = onFailure?.();
    if (outcome !== undefined) return outcome;
    return {
      settlement: { _tag: "ExpectedFailure" },
      observation: bounded(
        "filesystem target could not be resolved or accessed inside the sandbox",
      ),
      resultRef: null,
    };
  }
};
