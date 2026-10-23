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
import {
  armProviderResponseGate,
  releaseProviderResponse,
  type StartedRealProviderFixture,
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
    const selector = {
      requiredAdvertisedToolName: "patch",
      requiredMessageText: "S2-CORRECTION-UNIT",
    } as const;
    armProviderResponseGate(run, selector);

    const selectorOnDisk = JSON.parse(
      readFileSync(
        join(run.responseGateDirectory as string, "selector.json"),
        "utf8",
      ),
    ) as typeof selector;
    expect(selectorOnDisk).toEqual(selector);

    const ignoredRootId = randomUUID();
    const selectedWorkId = randomUUID();
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
    const unrelatedRequest = {
      messages: [{ role: "user", content: "S2-CORRECTION-UNIT" }],
      tools: [{ type: "function", function: { name: "assign_work" } }],
    };
    const captures = [
      {
        event: "request-start",
        requestId: ignoredRootId,
        processId: 1,
        sequence: 1,
        method: "POST",
        path: "/v1/chat/completions",
      },
      {
        event: "response-complete",
        requestId: ignoredRootId,
        processId: 1,
        sequence: 2,
        method: "POST",
        path: "/v1/chat/completions",
        request: unrelatedRequest,
        status: 200,
      },
      {
        event: "response-held",
        requestId: ignoredRootId,
        processId: 1,
        sequence: 2,
        method: "POST",
        path: "/v1/chat/completions",
        request: unrelatedRequest,
        status: 200,
      },
      {
        event: "response-complete",
        requestId: selectedWorkId,
        processId: 1,
        sequence: 3,
        method: "POST",
        path: "/v1/chat/completions",
        request: selectedRequest,
        status: 200,
      },
      {
        event: "response-held",
        requestId: selectedWorkId,
        processId: 1,
        sequence: 3,
        method: "POST",
        path: "/v1/chat/completions",
        request: selectedRequest,
        status: 200,
      },
    ];
    writeFileSync(
      run.captureFile,
      `${captures.map((capture) => JSON.stringify(capture)).join("\n")}\n`,
      { encoding: "utf8" },
    );

    const held = await waitForHeldProviderResponse(run, {
      afterSequence: 1,
      deadlineAt: Date.now() + 1_000,
      selector,
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
