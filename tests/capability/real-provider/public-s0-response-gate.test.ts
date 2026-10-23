import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../support/p39-windows-deployment-test.js";
import { providerResponseMatchesSelector } from "./provider-response-gate.mjs";
import {
  armProviderResponseGate,
  releaseProviderResponse,
  type StartedRealProviderFixture,
  updateProviderResponseGateSelector,
  waitForHeldProviderResponse,
} from "./public-real-journey-support.js";

const privateDirectories: Array<string> = [];

afterEach(() => {
  for (const directory of privateDirectories.splice(0)) {
    removeP39PrivateTestDirectory(directory);
  }
});

const makeRun = (): StartedRealProviderFixture => {
  const privateDirectory = makeP39PrivateTestDirectory(
    tmpdir(),
    "arbor-real-provider-gate-unit-",
  );
  privateDirectories.push(privateDirectory);
  const captureFile = join(privateDirectory, "captures.jsonl");
  createP39PrivateTestFile(captureFile);
  return {
    captureFile,
    evidenceDirectory: privateDirectory,
    responseGateDirectory: privateDirectory,
    fixture: {} as StartedRealProviderFixture["fixture"],
  };
};

describe("real Provider response gate capture contract", () => {
  it("waits for the exact corrected Work held-response body and releases its request id", async () => {
    const run = makeRun();
    const workSelector = {
      requiredAdvertisedToolName: "patch",
      requiredMessageText: "S2-WORK-UNIT",
    } as const;
    armProviderResponseGate(run, workSelector);

    const selectorOnDisk = JSON.parse(
      readFileSync(
        join(run.responseGateDirectory as string, "selector.json"),
        "utf8",
      ),
    ) as typeof workSelector;
    expect(selectorOnDisk).toEqual(workSelector);

    const initialHeldId = randomUUID();
    const intermediateId = randomUUID();
    const selectedWorkId = randomUUID();
    const initialWorkRequest = {
      messages: [{ role: "user", content: "S2-WORK-UNIT" }],
      tools: [{ type: "function", function: { name: "patch" } }],
    };
    const intermediateRequest = {
      messages: [{ role: "user", content: "S2-WORK-UNIT" }],
      tools: [{ type: "function", function: { name: "patch" } }],
    };
    const selectedRequest = {
      messages: [
        {
          role: "developer",
          content: "In a WorkspaceWork turn bound to a current Work.",
        },
        { role: "user", content: "S2-CORRECTION-UNIT" },
      ],
      tools: [{ type: "function", function: { name: "patch" } }],
    };
    const initialCaptures = [
      {
        event: "request-start",
        requestId: initialHeldId,
        processId: 1,
        sequence: 1,
        method: "POST",
        path: "/v1/chat/completions",
      },
      {
        event: "response-complete",
        requestId: initialHeldId,
        processId: 1,
        sequence: 2,
        method: "POST",
        path: "/v1/chat/completions",
        request: initialWorkRequest,
        status: 200,
      },
      {
        event: "response-held",
        requestId: initialHeldId,
        processId: 1,
        sequence: 2,
        method: "POST",
        path: "/v1/chat/completions",
        request: initialWorkRequest,
        status: 200,
      },
    ];
    writeFileSync(
      run.captureFile,
      `${initialCaptures.map((capture) => JSON.stringify(capture)).join("\n")}\n`,
      { encoding: "utf8" },
    );

    const correctionSelector = {
      requiredAdvertisedToolName: "patch",
      requiredMessageText: "S2-CORRECTION-UNIT",
    } as const;
    expect(
      providerResponseMatchesSelector(initialWorkRequest, workSelector),
    ).toBe(true);
    expect(
      providerResponseMatchesSelector(intermediateRequest, correctionSelector),
    ).toBe(false);
    expect(
      providerResponseMatchesSelector(selectedRequest, correctionSelector),
    ).toBe(true);
    updateProviderResponseGateSelector(run, correctionSelector);
    const updatedSelector = JSON.parse(
      readFileSync(
        join(run.responseGateDirectory as string, "selector.json"),
        "utf8",
      ),
    );
    expect(updatedSelector).toEqual(correctionSelector);
    releaseProviderResponse(run, initialHeldId);
    expect(
      readFileSync(
        join(run.responseGateDirectory as string, `release-${initialHeldId}`),
        "utf8",
      ),
    ).toBe("");

    const postSteerCaptures = [
      {
        event: "response-complete",
        requestId: intermediateId,
        processId: 1,
        sequence: 3,
        method: "POST",
        path: "/v1/chat/completions",
        request: intermediateRequest,
        status: 200,
      },
    ];
    writeFileSync(
      run.captureFile,
      `${postSteerCaptures.map((capture) => JSON.stringify(capture)).join("\n")}\n`,
      { encoding: "utf8", flag: "a" },
    );

    const correctionCaptures = [
      {
        event: "response-complete",
        requestId: selectedWorkId,
        processId: 1,
        sequence: 4,
        method: "POST",
        path: "/v1/chat/completions",
        request: selectedRequest,
        status: 200,
      },
      {
        event: "response-held",
        requestId: selectedWorkId,
        processId: 1,
        sequence: 4,
        method: "POST",
        path: "/v1/chat/completions",
        request: selectedRequest,
        status: 200,
      },
    ];
    writeFileSync(
      run.captureFile,
      `${correctionCaptures.map((capture) => JSON.stringify(capture)).join("\n")}\n`,
      {
        encoding: "utf8",
        flag: "a",
      },
    );

    const held = await waitForHeldProviderResponse(run, {
      afterSequence: 2,
      deadlineAt: Date.now() + 1_000,
      selector: correctionSelector,
    });
    expect(held.requestId).toBe(selectedWorkId);
    expect(held.event).toBe("response-held");
    releaseProviderResponse(run, held.requestId);
    expect(
      readFileSync(
        join(run.responseGateDirectory as string, `release-${selectedWorkId}`),
        "utf8",
      ),
    ).toBe("");
  });
});
