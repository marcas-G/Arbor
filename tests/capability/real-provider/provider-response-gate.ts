import { readFileSync } from "node:fs";
import { providerResponseMatchesSelector } from "./provider-response-gate.mjs";
import type {
  CorrelatedHeldProviderResponseCapture,
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
): Promise<CorrelatedHeldProviderResponseCapture> => {
  while (Date.now() < input.deadlineAt) {
    const captures = readProviderCaptures(run.captureFile);
    const candidateHeld = captures.find(
      (capture) =>
        capture.event === "response-held" &&
        capture.sequence > input.afterSequence &&
        (input.selector === undefined ||
          providerCaptureMatchesSelector(capture, input.selector)),
    );
    if (candidateHeld !== undefined) {
      const matchingHeld = captures.filter(
        (capture) =>
          capture.event === "response-held" &&
          capture.requestId === candidateHeld.requestId,
      );
      if (matchingHeld.length !== 1) {
        throw new Error(
          "REAL NOT QUALIFIED: held Provider response has duplicate held captures",
        );
      }
      const held = matchingHeld[0];
      if (held === undefined) {
        throw new Error(
          "REAL NOT QUALIFIED: selected held Provider response disappeared",
        );
      }
      const completed = captures.filter(
        (capture) =>
          capture.event === "response-complete" &&
          capture.requestId === held.requestId,
      );
      if (completed.length === 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        continue;
      }
      if (completed.length !== 1) {
        throw new Error(
          "REAL NOT QUALIFIED: held Provider response has duplicate completion captures",
        );
      }
      const response = completed[0];
      const requestEvidenceMatches =
        response !== undefined &&
        held.sequence !== undefined &&
        held.processId !== undefined &&
        held.method !== undefined &&
        held.path !== undefined &&
        held.request !== undefined &&
        response.sequence === held.sequence &&
        response.processId === held.processId &&
        response.method === held.method &&
        response.path === held.path &&
        response.request !== undefined &&
        JSON.stringify(response.request) === JSON.stringify(held.request);
      if (
        response === undefined ||
        !requestEvidenceMatches ||
        held.status === undefined ||
        response.status === undefined ||
        response.responseBodyBase64 === undefined ||
        held.status !== response.status ||
        (held.responseBodyBase64 !== undefined &&
          held.responseBodyBase64 !== response.responseBodyBase64)
      ) {
        throw new Error(
          "REAL NOT QUALIFIED: held Provider response does not match its exact completion capture",
        );
      }
      return {
        ...held,
        event: "response-held",
        status: response.status,
        responseBodyBase64: response.responseBodyBase64,
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(
    "REAL NOT QUALIFIED: deadline waiting for a genuine held Provider response",
  );
};

export const providerCaptureMatchesSelector = (
  capture: ProviderCapture,
  selector: ProviderResponseGateSelector,
): boolean => providerResponseMatchesSelector(capture.request ?? {}, selector);

export type {
  CorrelatedHeldProviderResponseCapture,
  ProviderCapture,
} from "./public-real-journey-support.js";
