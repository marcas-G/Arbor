import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  readProviderCaptures,
  waitForHeldProviderResponse,
} from "./provider-response-gate.js";
import type {
  ProviderCapture,
  StartedRealProviderFixture,
} from "./public-real-journey-support.js";

const captureFileEnv = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const captureEndpointEnv = "ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT";
const responseGateDirectoryEnv = "ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR";
const responseGateTimeoutEnv = "ARBOR_PUBLIC_S1_RESPONSE_GATE_TIMEOUT_MS";

const waitForCapture = async (
  captureFile: string,
  predicate: (captures: ReadonlyArray<ProviderCapture>) => boolean,
): Promise<ReadonlyArray<ProviderCapture>> => {
  const deadlineAt = Date.now() + 2_000;
  while (Date.now() < deadlineAt) {
    const captures = readProviderCaptures(captureFile);
    if (predicate(captures)) return captures;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "response gate harness did not observe the expected capture event",
  );
};

it("associates a held correction with its body and releases it from finally after an error", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "s3-gate-harness-"));
  const gateDirectory = join(tempRoot, "gate");
  mkdirSync(gateDirectory);
  const captureFile = join(tempRoot, "provider-captures.jsonl");
  writeFileSync(captureFile, "", { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(gateDirectory, "armed"), "", {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(
    join(gateDirectory, "selector.json"),
    `${JSON.stringify({
      requiredAdvertisedToolName: "patch",
      requiredMessageText: "S3-GATE-CORRECTION",
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const envBefore = new Map<string, string | undefined>([
    [captureFileEnv, process.env[captureFileEnv]],
    [captureEndpointEnv, process.env[captureEndpointEnv]],
    [responseGateDirectoryEnv, process.env[responseGateDirectoryEnv]],
    [responseGateTimeoutEnv, process.env[responseGateTimeoutEnv]],
    [
      "ARBOR_PUBLIC_S1_CAPTURE_SEQUENCE",
      process.env.ARBOR_PUBLIC_S1_CAPTURE_SEQUENCE,
    ],
  ]);
  const originalFetch = globalThis.fetch;
  const endpoint = "https://provider.test/v1";
  const marker = "S3-GATE-CORRECTION";
  const sequenceSeed = randomUUID();
  let pendingFetch: Promise<Response> | undefined;
  let heldRequest: ProviderCapture | undefined;
  let observedError: unknown;

  try {
    process.env[captureFileEnv] = captureFile;
    process.env[captureEndpointEnv] = endpoint;
    process.env[responseGateDirectoryEnv] = gateDirectory;
    process.env[responseGateTimeoutEnv] = "1500";
    process.env.ARBOR_PUBLIC_S1_CAPTURE_SEQUENCE = "0";
    globalThis.fetch = (async () =>
      new Response("synthetic upstream response", {
        status: 200,
      })) as typeof fetch;

    const hookUrl = new URL(
      "./provider-fetch-capture-hook.mjs",
      import.meta.url,
    ).href;
    await import(`${hookUrl}?harness=${sequenceSeed}`);
    const run = {
      captureFile,
      responseGateDirectory: gateDirectory,
    } as unknown as StartedRealProviderFixture;
    const requestBody = JSON.stringify({
      model: "synthetic-provider-model",
      messages: [{ role: "user", content: marker }],
      tools: [{ function: { name: "patch" } }],
    });

    try {
      pendingFetch = globalThis.fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      });
      heldRequest = await waitForHeldProviderResponse(run, {
        afterSequence: 0,
        deadlineAt: Date.now() + 1_000,
        selector: {
          requiredAdvertisedToolName: "patch",
          requiredMessageText: marker,
        },
      });
      const captures = readProviderCaptures(captureFile);
      const start = captures.find(
        (capture) =>
          capture.event === "request-start" &&
          capture.requestId === heldRequest?.requestId,
      );
      const complete = captures.find(
        (capture) =>
          capture.event === "response-complete" &&
          capture.requestId === heldRequest?.requestId,
      );
      expect(start?.request).toBeUndefined();
      expect(JSON.stringify(start)).not.toContain(marker);
      expect(heldRequest.sequence).toBe(start?.sequence);
      expect(JSON.stringify(heldRequest.request)).toContain(marker);
      expect(complete?.sequence).toBe(heldRequest.sequence);
      expect(complete?.responseBodyBase64).toBeDefined();
      throw new Error("synthetic assertion failure while response is held");
    } catch (error) {
      observedError = error;
    } finally {
      if (heldRequest !== undefined) {
        writeFileSync(
          join(gateDirectory, `release-${heldRequest.requestId}`),
          "",
          { encoding: "utf8", mode: 0o600 },
        );
      }
    }

    expect(observedError).toBeInstanceOf(Error);
    expect((observedError as Error).message).toBe(
      "synthetic assertion failure while response is held",
    );
    if (pendingFetch === undefined) {
      throw new Error("synthetic fetch request was not started");
    }
    const response = await pendingFetch;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("synthetic upstream response");
    const releasedCaptures = await waitForCapture(captureFile, (captures) =>
      captures.some(
        (capture) =>
          capture.event === "response-released" &&
          capture.requestId === heldRequest?.requestId,
      ),
    );
    const correlatedEvents = releasedCaptures
      .filter((capture) => capture.requestId === heldRequest?.requestId)
      .map((capture) => capture.event);
    expect(correlatedEvents).toEqual([
      "request-start",
      "response-complete",
      "response-held",
      "response-released",
    ]);
  } finally {
    const captures = readProviderCaptures(captureFile);
    const alreadyReleased = new Set(
      captures
        .filter((capture) => capture.event === "response-released")
        .map((capture) => capture.requestId),
    );
    for (const capture of captures) {
      if (
        capture.event === "response-held" &&
        !alreadyReleased.has(capture.requestId)
      ) {
        writeFileSync(join(gateDirectory, `release-${capture.requestId}`), "", {
          encoding: "utf8",
          mode: 0o600,
        });
      }
    }
    globalThis.fetch = originalFetch;
    for (const [name, value] of envBefore) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await pendingFetch?.catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}, 8_000);
