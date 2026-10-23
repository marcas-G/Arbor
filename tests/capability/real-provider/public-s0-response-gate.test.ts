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
    privateRunDirectory: privateDirectory,
    responseGateDirectory: privateDirectory,
    fixture: {} as StartedRealProviderFixture["fixture"],
  };
};

const actionCallBody =
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n';
const plainResponseBody =
  'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n';
const hasActionCall = (bodyBase64: string): boolean =>
  /"(?:tool_calls|function_call)"\s*:/u.test(
    Buffer.from(bodyBase64, "base64").toString("utf8"),
  );

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
        responseBodyBase64: Buffer.from(actionCallBody).toString("base64"),
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
        responseBodyBase64: Buffer.from(actionCallBody).toString("base64"),
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
    expect(correctionCaptures[1]).not.toHaveProperty("responseBodyBase64");

    const held = await waitForHeldProviderResponse(run, {
      afterSequence: 2,
      deadlineAt: Date.now() + 1_000,
      selector: correctionSelector,
    });
    expect(held.requestId).toBe(selectedWorkId);
    expect(held.event).toBe("response-held");
    expect(held.responseBodyBase64).toBe(
      Buffer.from(actionCallBody).toString("base64"),
    );
    expect(hasActionCall(held.responseBodyBase64)).toBe(true);
    releaseProviderResponse(run, held.requestId);
    expect(
      readFileSync(
        join(run.responseGateDirectory as string, `release-${selectedWorkId}`),
        "utf8",
      ),
    ).toBe("");
  });

  it("returns a correlated plain-text response body without fabricating an action call", async () => {
    const run = makeRun();
    const requestId = randomUUID();
    const request = {
      messages: [{ role: "user", content: "continue the bounded task" }],
      tools: [{ type: "function", function: { name: "read" } }],
    };
    writeFileSync(
      run.captureFile,
      `${[
        {
          event: "response-complete",
          requestId,
          processId: 1,
          sequence: 9,
          method: "POST",
          path: "/v1/chat/completions",
          request,
          status: 200,
          responseBodyBase64: Buffer.from(plainResponseBody).toString("base64"),
        },
        {
          event: "response-held",
          requestId,
          processId: 1,
          sequence: 9,
          method: "POST",
          path: "/v1/chat/completions",
          request,
          status: 200,
        },
      ]
        .map((capture) => JSON.stringify(capture))
        .join("\n")}\n`,
      { encoding: "utf8" },
    );

    const held = await waitForHeldProviderResponse(run, {
      afterSequence: 8,
      deadlineAt: Date.now() + 1_000,
    });
    expect(held.event).toBe("response-held");
    expect(held.status).toBe(200);
    expect(held.responseBodyBase64).toBe(
      Buffer.from(plainResponseBody).toString("base64"),
    );
    expect(hasActionCall(held.responseBodyBase64)).toBe(false);
  });

  it.each([
    ["duplicate", 200, "same request"],
    ["conflicting", 201, "different request"],
  ])(
    "fails closed on %s held captures sharing one request id",
    async (_kind, duplicateStatus, duplicateContent) => {
      const run = makeRun();
      const requestId = randomUUID();
      const request = {
        messages: [{ role: "user", content: "same request" }],
      };
      const duplicateRequest = {
        messages: [{ role: "user", content: duplicateContent }],
      };
      const complete = {
        event: "response-complete",
        requestId,
        processId: 1,
        sequence: 10,
        method: "POST",
        path: "/v1/chat/completions",
        request,
        status: 200,
        responseBodyBase64: Buffer.from(actionCallBody).toString("base64"),
      };
      const held = {
        event: "response-held",
        requestId,
        processId: 1,
        sequence: 10,
        method: "POST",
        path: "/v1/chat/completions",
        request,
        status: 200,
      };
      const duplicateHeld = {
        ...held,
        request: duplicateRequest,
        status: duplicateStatus,
      };
      writeFileSync(
        run.captureFile,
        `${[complete, held, duplicateHeld]
          .map((capture) => JSON.stringify(capture))
          .join("\n")}\n`,
        { encoding: "utf8" },
      );

      await expect(
        waitForHeldProviderResponse(run, {
          afterSequence: 9,
          deadlineAt: Date.now() + 1_000,
        }),
      ).rejects.toThrow(
        "REAL NOT QUALIFIED: held Provider response has duplicate held captures",
      );
    },
  );

  it.each([
    [
      "sequence",
      {
        heldSequence: 10,
        completeSequence: 11,
        heldStatus: 200,
        completeStatus: 200,
        heldContent: "same",
        completeContent: "same",
      },
    ],
    [
      "status",
      {
        heldSequence: 10,
        completeSequence: 10,
        heldStatus: 200,
        completeStatus: 201,
        heldContent: "same",
        completeContent: "same",
      },
    ],
    [
      "request",
      {
        heldSequence: 10,
        completeSequence: 10,
        heldStatus: 200,
        completeStatus: 200,
        heldContent: "held request",
        completeContent: "complete request",
      },
    ],
  ])(
    "fails closed when held and complete captures disagree on %s",
    async (_kind, mismatch) => {
      const run = makeRun();
      const requestId = randomUUID();
      const capture = (
        event: "response-complete" | "response-held",
        sequence: number,
        status: number,
        content: string,
      ) => ({
        event,
        requestId,
        processId: 1,
        sequence,
        method: "POST",
        path: "/v1/chat/completions",
        request: { messages: [{ role: "user", content }] },
        status,
        ...(event === "response-complete"
          ? {
              responseBodyBase64:
                Buffer.from(actionCallBody).toString("base64"),
            }
          : {}),
      });
      writeFileSync(
        run.captureFile,
        `${[
          capture(
            "response-complete",
            mismatch.completeSequence,
            mismatch.completeStatus,
            mismatch.completeContent,
          ),
          capture(
            "response-held",
            mismatch.heldSequence,
            mismatch.heldStatus,
            mismatch.heldContent,
          ),
        ]
          .map((value) => JSON.stringify(value))
          .join("\n")}\n`,
        { encoding: "utf8" },
      );

      await expect(
        waitForHeldProviderResponse(run, {
          afterSequence: 9,
          deadlineAt: Date.now() + 1_000,
        }),
      ).rejects.toThrow(
        "REAL NOT QUALIFIED: held Provider response does not match its exact completion capture",
      );
    },
  );
});
