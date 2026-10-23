import { readFileSync } from "node:fs";
import { providerResponseMatchesSelector } from "./provider-response-gate.mjs";
import type {
  ProviderCapture,
  ProviderResponseGateSelector,
  StartedRealProviderFixture,
} from "./public-real-journey-support.js";

export const readProviderCaptures = (
  captureFile: string,
): Array<ProviderCapture> => {
  try {
    const text = readFileSync(captureFile, "utf8");
    return text
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ProviderCapture];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

export const waitForHeldProviderResponse = async (
  run: StartedRealProviderFixture,
  input: {
    readonly afterSequence: number;
    readonly deadlineAt: number;
    readonly selector?: ProviderResponseGateSelector;
  },
): Promise<ProviderCapture> => {
  while (Date.now() < input.deadlineAt) {
    const captures = readProviderCaptures(run.captureFile);
    const held = captures.find(
      (capture) =>
        capture.event === "response-held" &&
        capture.sequence > input.afterSequence &&
        (input.selector === undefined ||
          providerCaptureMatchesSelector(capture, input.selector)) &&
        captures.some(
          (completed) =>
            completed.event === "response-complete" &&
            completed.requestId === capture.requestId &&
            completed.sequence === capture.sequence,
        ),
    );
    if (held !== undefined) return held;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    "REAL NOT QUALIFIED: deadline waiting for a genuine held Provider response",
  );
};

export const providerCaptureMatchesSelector = (
  capture: ProviderCapture,
  selector: ProviderResponseGateSelector,
): boolean =>
  providerResponseMatchesSelector(capture.request ?? {}, selector);

export type { ProviderCapture } from "./public-real-journey-support.js";
