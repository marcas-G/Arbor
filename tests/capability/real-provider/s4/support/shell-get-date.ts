// REAL S4 held-response shell oracle (B5 split): decodes the captured held
// Provider response and requires exactly one bounded read-only shell
// Get-Date tool call. Bodies are moved verbatim from the former monolithic
// public-s4-recovery.test.ts.
import { isDeepStrictEqual } from "node:util";
import type { CapturedProviderToolCall } from "../../public-real-journey-support.js";
import { decodeCapturedProviderToolCalls } from "../../public-real-journey-support.js";

const requireSingleShellGetDateToolCall = (
  responseBodyBase64: string,
): CapturedProviderToolCall => {
  const calls = decodeCapturedProviderToolCalls(responseBodyBase64);
  if (calls.length !== 1) {
    throw new Error(
      "held Provider response must contain exactly one tool call",
    );
  }
  const call = calls[0];
  if (call?.name !== "shell" || call.arguments.command !== "Get-Date") {
    throw new Error(
      "held Provider response is not the exact shell Get-Date call",
    );
  }
  const cwd = call.arguments.cwd;
  if (
    typeof cwd !== "object" ||
    cwd === null ||
    Array.isArray(cwd) ||
    !isDeepStrictEqual(cwd, { mount: "workspace", path: "." })
  ) {
    throw new Error("shell Get-Date must target the current workspace mount");
  }
  if (
    Object.keys(call.arguments).some(
      (key) => !["command", "cwd", "timeoutMs"].includes(key),
    ) ||
    (call.arguments.timeoutMs !== undefined &&
      (typeof call.arguments.timeoutMs !== "number" ||
        !Number.isInteger(call.arguments.timeoutMs) ||
        call.arguments.timeoutMs < 1 ||
        call.arguments.timeoutMs > 5_000))
  ) {
    throw new Error(
      "shell Get-Date arguments exceed the bounded read-only call",
    );
  }
  return call;
};

export { requireSingleShellGetDateToolCall };
