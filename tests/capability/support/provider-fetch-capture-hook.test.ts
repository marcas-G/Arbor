import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  decodeCapturedProviderToolCalls,
  type ProviderCapture,
  providerCaptureMatchesSelector,
  providerRequestEvidence,
  providerRequestsMatching,
  type StartedRealProviderFixture,
  waitForHeldProviderResponse,
} from "../real-provider/public-real-journey-support.js";

const hookPath = fileURLToPath(
  new URL("../real-provider/provider-fetch-capture-hook.mjs", import.meta.url),
);

const readCaptureLines = (captureFile: string): Array<ProviderCapture> => {
  try {
    return readFileSync(captureFile, "utf8")
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

const waitForHeldLine = async (
  captureFile: string,
  deadlineAt: number,
): Promise<ProviderCapture> => {
  while (Date.now() < deadlineAt) {
    const held = readCaptureLines(captureFile).find(
      (capture) => capture.event === "response-held",
    );
    if (held !== undefined) return held;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("stubbed Provider fetch did not reach response-held");
};

const waitForCapture = async (
  captureFile: string,
  predicate: (capture: ProviderCapture) => boolean,
  deadlineAt: number,
): Promise<ProviderCapture> => {
  while (Date.now() < deadlineAt) {
    const capture = readCaptureLines(captureFile).find(predicate);
    if (capture !== undefined) return capture;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("stubbed Provider capture did not reach the expected event");
};

const makeGateRun = (): StartedRealProviderFixture => {
  const privateDirectory = join(
    tmpdir(),
    `arbor-provider-response-selector-${randomUUID()}`,
  );
  mkdirSync(privateDirectory, { recursive: true });
  const captureFile = join(privateDirectory, "captures.jsonl");
  writeFileSync(captureFile, "", { encoding: "utf8", mode: 0o600 });
  return {
    captureFile,
    evidenceDirectory: privateDirectory,
    privateRunDirectory: privateDirectory,
    archiveResultDirectory: privateDirectory,
    ownsArchiveResultDirectory: false,
    responseGateDirectory: privateDirectory,
    fixture: {} as StartedRealProviderFixture["fixture"],
  };
};

const waitForExit = (child: ChildProcess, timeoutMs: number) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    const timer = setTimeout(
      () => rejectExit(new Error("stubbed fetch child did not exit")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
};

const spawnStubFetch = (input: {
  readonly endpoint: string;
  readonly hookUrl: string;
  readonly captureFile: string;
  readonly responseGateDirectory: string;
  readonly marker: string;
  readonly advertisedToolName?: string;
  readonly responseBodies?: ReadonlyArray<string>;
  readonly observedBodiesFile?: string;
}) => {
  const source = `
    import { writeFileSync } from "node:fs";
    const responseBodies = ${JSON.stringify(input.responseBodies ?? ["stubbed-upstream-response"])};
    let responseIndex = 0;
    const observedBodies = [];
    globalThis.fetch = async () => new Response(responseBodies[responseIndex++] ?? "missing-stubbed-response", { status: 200 });
    await import(${JSON.stringify(input.hookUrl)});
    for (let index = 0; index < responseBodies.length; index += 1) {
      const request = new Request(${JSON.stringify(`${input.endpoint}/chat/completions`)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: ${JSON.stringify(input.marker)} }],
          tools: [{ function: { name: ${JSON.stringify(input.advertisedToolName ?? "assign_work")} } }]
        })
      });
      const response = await globalThis.fetch(request);
      observedBodies.push(await response.text());
    }
    ${input.observedBodiesFile === undefined ? "" : `writeFileSync(${JSON.stringify(input.observedBodiesFile)}, JSON.stringify(observedBodies));`}
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      TEMP: tmpdir(),
      TMP: tmpdir(),
      ARBOR_PUBLIC_S1_CAPTURE_FILE: input.captureFile,
      ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT: input.endpoint,
      ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR: input.responseGateDirectory,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
};

it("captures the request body on response-held, matches that event, and releases the same held response", async () => {
  const directory = join(tmpdir(), `arbor-provider-gate-${randomUUID()}`);
  const gateDirectory = join(directory, "gate");
  const captureFile = join(directory, "captures.jsonl");
  mkdirSync(gateDirectory, { recursive: true });
  writeFileSync(captureFile, "", { encoding: "utf8", mode: 0o600 });

  const children: Array<ChildProcess> = [];
  try {
    const marker = `gate-target-${randomUUID()}`;
    const endpoint = "http://fake-provider.invalid/v1";
    const selector = {
      requiredMessageText: marker,
      requiredAdvertisedToolName: "assign_work",
    };
    writeFileSync(
      join(gateDirectory, "selector.json"),
      JSON.stringify(selector),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    writeFileSync(join(gateDirectory, "armed"), "", {
      encoding: "utf8",
      mode: 0o600,
    });

    const hookUrl = pathToFileURL(resolve(hookPath)).href;
    const child = spawnStubFetch({
      endpoint,
      hookUrl,
      captureFile,
      responseGateDirectory: gateDirectory,
      marker,
    });
    children.push(child);
    const stderr: Array<string> = [];
    child.stderr?.on("data", (chunk: Buffer) =>
      stderr.push(chunk.toString("utf8")),
    );
    const exited = waitForExit(child, 5_000);

    const held = await waitForHeldLine(captureFile, Date.now() + 3_000);
    const captures = readCaptureLines(captureFile);
    const start = captures.find(
      (capture) =>
        capture.requestId === held.requestId &&
        capture.event === "request-start",
    );
    const completed = captures.find(
      (capture) =>
        capture.requestId === held.requestId &&
        capture.event === "response-complete",
    );
    const completedIndex = captures.findIndex(
      (capture) =>
        capture.requestId === held.requestId &&
        capture.event === "response-complete",
    );
    const heldIndex = captures.findIndex(
      (capture) =>
        capture.requestId === held.requestId &&
        capture.event === "response-held",
    );

    expect(start).toBeDefined();
    expect(start?.request).toBeUndefined();
    expect(completed?.request).toEqual(held.request);
    expect(JSON.stringify(completed?.request ?? {})).toContain(marker);
    expect(completedIndex).toBeGreaterThanOrEqual(0);
    expect(heldIndex).toBeGreaterThan(completedIndex);
    expect(held.request?.messages).toEqual([{ role: "user", content: marker }]);
    expect(
      providerCaptureMatchesSelector(start as ProviderCapture, selector),
    ).toBe(false);
    expect(providerCaptureMatchesSelector(held, selector)).toBe(true);
    const correlated = providerRequestEvidence(captures, held.requestId);
    expect(correlated._tag).toBe("Bound");
    if (correlated._tag !== "Bound") {
      throw new Error(`request evidence was not bound: ${correlated.reason}`);
    }
    expect(correlated.requestStart.request).toBeUndefined();
    expect(correlated.requestStart.sequence).toBe(held.sequence);
    expect(correlated.request).toEqual(held.request);
    expect(
      providerRequestsMatching(captures, (requestBody) =>
        JSON.stringify(requestBody).includes(marker),
      ),
    ).toEqual([correlated]);

    const duplicateStart = providerRequestEvidence(
      [...captures, start as ProviderCapture],
      held.requestId,
    );
    expect(duplicateStart).toMatchObject({
      _tag: "Invalid",
      reason: "DuplicateRequestStart",
    });
    const completedCapture = captures.find(
      (capture) =>
        capture.event === "response-complete" &&
        capture.requestId === held.requestId,
    );
    if (
      completedCapture === undefined ||
      completedCapture.request === undefined
    ) {
      throw new Error("stubbed response-complete request evidence is missing");
    }
    expect(
      providerRequestEvidence([...captures, completedCapture], held.requestId),
    ).toMatchObject({
      _tag: "Invalid",
      reason: "DuplicateBodyEvent",
    });
    const conflictedCaptures = captures.map((capture) =>
      capture === completedCapture
        ? {
            ...capture,
            request: {
              ...completedCapture.request,
              messages: [{ role: "user", content: "conflicting-body" }],
            },
          }
        : capture,
    );
    expect(
      providerRequestEvidence(conflictedCaptures, held.requestId),
    ).toMatchObject({
      _tag: "Invalid",
      reason: "ConflictingRequestBody",
    });

    const helperRun = {
      captureFile,
      responseGateDirectory: gateDirectory,
    } as StartedRealProviderFixture;
    const selectedHeld = await waitForHeldProviderResponse(helperRun, {
      afterSequence: held.sequence - 1,
      deadlineAt: Date.now() + 200,
      selector,
    });
    expect(selectedHeld.requestId).toBe(held.requestId);
    await expect(
      waitForHeldProviderResponse(helperRun, {
        afterSequence: held.sequence,
        deadlineAt: Date.now() + 100,
        selector,
      }),
    ).rejects.toThrow("deadline waiting for a genuine held Provider response");

    writeFileSync(join(gateDirectory, `release-${held.requestId}`), "", {
      encoding: "utf8",
      mode: 0o600,
    });
    const exit = await exited;
    expect(exit).toEqual({ code: 0, signal: null });
    const released = readCaptureLines(captureFile).find(
      (capture) =>
        capture.requestId === held.requestId &&
        capture.event === "response-released",
    );
    expect(released).toBeDefined();
    expect(stderr.join("")).toBe("");

    const restartedMarker = `restart-target-${randomUUID()}`;
    const restarted = spawnStubFetch({
      endpoint,
      hookUrl,
      captureFile,
      responseGateDirectory: "",
      marker: restartedMarker,
    });
    children.push(restarted);
    const restartExit = await waitForExit(restarted, 2_000);
    expect(restartExit).toEqual({ code: 0, signal: null });
    const restartedComplete = await waitForCapture(
      captureFile,
      (capture) =>
        capture.event === "response-complete" &&
        JSON.stringify(capture.request ?? {}).includes(restartedMarker),
      Date.now() + 1_000,
    );
    const restartedCaptures = readCaptureLines(captureFile);
    const restartRequestId = restartedComplete.requestId;
    const restartedStart = restartedCaptures.find(
      (capture) =>
        capture.event === "request-start" &&
        capture.requestId === restartRequestId,
    );
    expect(restartedStart).toBeDefined();
    expect(restartedStart?.request).toBeUndefined();
    expect(
      restartedCaptures.some(
        (capture) =>
          capture.event === "response-held" &&
          capture.requestId === restartRequestId,
      ),
    ).toBe(false);
    expect(
      restartedCaptures.some(
        (capture) =>
          capture.event === "response-complete" &&
          capture.requestId === restartRequestId,
      ),
    ).toBe(true);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 1_000).catch(() => undefined);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

it("passes nonmatching authentic responses through and holds only the exact fragmented shell tool call", async () => {
  const run = makeGateRun();
  const observedBodiesFile = join(
    run.privateRunDirectory,
    "observed-bodies.json",
  );
  const marker = `S4B-GATE-${randomUUID()}`;
  const endpoint = "http://fake-provider.invalid/v1";
  const selector = {
    requiredAdvertisedToolName: "shell",
    requiredMessageText: marker,
    requiredResponseToolCall: {
      name: "shell",
      requiredArguments: {
        command: "Get-Date",
        cwd: { mount: "workspace", path: "." },
      },
      allowedAdditionalArguments: ["timeoutMs"],
      numericArgumentMaximums: { timeoutMs: 5_000 },
    },
  } as const;
  writeFileSync(
    join(run.responseGateDirectory as string, "selector.json"),
    JSON.stringify(selector),
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(join(run.responseGateDirectory as string, "armed"), "", {
    encoding: "utf8",
    mode: 0o600,
  });

  const textResponse =
    'data: {"choices":[{"index":0,"delta":{"content":"planning"}}]}\n' +
    "data: [DONE]\n";
  const shellResponse =
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: "sh",
                  arguments: '{"command":"Get-',
                },
              },
            ],
          },
        },
      ],
    })}\n` +
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: "ell",
                  arguments:
                    'Date","cwd":{"mount":"workspace","path":"."},"timeoutMs":5000}',
                },
              },
            ],
          },
        },
      ],
    })}\n` +
    "data: [DONE]\n";
  const child = spawnStubFetch({
    endpoint,
    hookUrl: pathToFileURL(resolve(hookPath)).href,
    captureFile: run.captureFile,
    responseGateDirectory: run.responseGateDirectory as string,
    marker,
    advertisedToolName: "shell",
    responseBodies: [textResponse, shellResponse],
    observedBodiesFile,
  });
  const stderr: Array<string> = [];
  child.stderr?.on("data", (chunk: Buffer) =>
    stderr.push(chunk.toString("utf8")),
  );
  const exited = waitForExit(child, 5_000);

  try {
    const firstComplete = await waitForCapture(
      run.captureFile,
      (capture) =>
        capture.event === "response-complete" && capture.sequence === 1,
      Date.now() + 3_000,
    );
    const capturesAfterFirst = readCaptureLines(run.captureFile);
    expect(
      capturesAfterFirst.some(
        (capture) =>
          capture.event === "response-held" &&
          capture.requestId === firstComplete.requestId,
      ),
    ).toBe(false);
    expect(
      providerCaptureMatchesSelector(
        firstComplete,
        selector,
        capturesAfterFirst,
      ),
    ).toBe(false);

    const held = await waitForHeldLine(run.captureFile, Date.now() + 3_000);
    expect(held.sequence).toBe(2);
    const captures = readCaptureLines(run.captureFile);
    const secondComplete = captures.find(
      (capture) =>
        capture.event === "response-complete" &&
        capture.requestId === held.requestId,
    );
    expect(secondComplete?.responseBodyBase64).toBe(
      Buffer.from(shellResponse).toString("base64"),
    );
    expect(providerCaptureMatchesSelector(held, selector, captures)).toBe(true);
    const heldResponse = await waitForHeldProviderResponse(run, {
      afterSequence: 1,
      deadlineAt: Date.now() + 1_000,
      selector,
    });
    expect(heldResponse.requestId).toBe(held.requestId);
    expect(
      decodeCapturedProviderToolCalls(heldResponse.responseBodyBase64),
    ).toEqual([
      {
        name: "shell",
        arguments: {
          command: "Get-Date",
          cwd: { mount: "workspace", path: "." },
          timeoutMs: 5_000,
        },
      },
    ]);

    writeFileSync(
      join(run.responseGateDirectory as string, `release-${held.requestId}`),
      "",
      { encoding: "utf8", mode: 0o600 },
    );
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(JSON.parse(readFileSync(observedBodiesFile, "utf8"))).toEqual([
      textResponse,
      shellResponse,
    ]);
    expect(stderr.join("")).toBe("");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, 1_000).catch(() => undefined);
    }
    rmSync(run.privateRunDirectory, { recursive: true, force: true });
  }
}, 10_000);
