import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  providerRequestMatchesSelector,
  providerResponseMatchesSelector,
} from "./provider-response-gate.mjs";

const captureFile = process.env.ARBOR_PUBLIC_S1_CAPTURE_FILE;
const endpointValue = process.env.ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT;
const responseGateDirectory = process.env.ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR;
const configuredGateTimeoutMs = Number(
  process.env.ARBOR_PUBLIC_S1_RESPONSE_GATE_TIMEOUT_MS,
);
const responseGateTimeoutMs =
  Number.isFinite(configuredGateTimeoutMs) && configuredGateTimeoutMs > 0
    ? Math.min(configuredGateTimeoutMs, 5 * 60_000)
    : 5 * 60_000;
const originalFetch = globalThis.fetch.bind(globalThis);

const safeValue = (value, key = "") => {
  if (/(authorization|api[_-]?key|secret|token|credential)/iu.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return value
      .replace(/bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]")
      .replace(
        /(["']?(?:authorization|api[_-]?key|secret|credential|token)["']?\s*[:=]\s*["'])[^"']+(["'])/giu,
        "$1[REDACTED]$2",
      );
  }
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        safeValue(child, childKey),
      ]),
    );
  }
  return value;
};

const matchesConfiguredProvider = (value) => {
  if (captureFile === undefined || endpointValue === undefined) return false;
  try {
    const requestUrl = new URL(value);
    const endpoint = new URL(endpointValue);
    return (
      requestUrl.origin === endpoint.origin &&
      requestUrl.pathname.startsWith(endpoint.pathname.replace(/\/+$/u, ""))
    );
  } catch {
    return false;
  }
};

const append = (record) => {
  if (captureFile === undefined) return;
  appendFileSync(captureFile, `${JSON.stringify(safeValue(record))}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

const responseGateSelectorForRequest = (request) => {
  if (
    !responseGateDirectory ||
    !existsSync(join(responseGateDirectory, "armed"))
  )
    return undefined;
  const selectorPath = join(responseGateDirectory, "selector.json");
  if (!existsSync(selectorPath)) return {};
  try {
    const selector = JSON.parse(readFileSync(selectorPath, "utf8"));
    return providerRequestMatchesSelector(request, selector)
      ? selector
      : undefined;
  } catch {
    return undefined;
  }
};

globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!matchesConfiguredProvider(url)) return originalFetch(input, init);

  const sequence =
    Number(process.env.ARBOR_PUBLIC_S1_CAPTURE_SEQUENCE ?? "0") + 1;
  process.env.ARBOR_PUBLIC_S1_CAPTURE_SEQUENCE = String(sequence);
  const pathname = new URL(url).pathname;
  const base = {
    processId: process.pid,
    requestId: randomUUID(),
    sequence,
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    path: pathname,
  };
  append({ ...base, event: "request-start" });

  const body =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : undefined;
  let request;
  if (body !== undefined) {
    try {
      request = JSON.parse(body);
    } catch {
      request = { unparsedBody: body };
    }
  }
  const requestEvidence = request === undefined ? base : { ...base, request };
  const candidateResponseGateSelector = responseGateSelectorForRequest(request);

  try {
    const response = await originalFetch(input, init);
    const clone = response.clone();
    if (candidateResponseGateSelector !== undefined) {
      const bytes = await clone.arrayBuffer();
      const rawBodyBase64 = Buffer.from(bytes).toString("base64");
      const bodyText = safeValue(new TextDecoder().decode(bytes));
      const safeBodyBase64 = Buffer.from(bodyText).toString("base64");
      append({
        ...requestEvidence,
        event: "response-complete",
        status: response.status,
        responseBodyBase64: safeBodyBase64,
      });
      if (
        !providerResponseMatchesSelector(
          request,
          candidateResponseGateSelector,
          rawBodyBase64,
        )
      ) {
        return response;
      }
      append({
        ...requestEvidence,
        event: "response-held",
        status: response.status,
      });
      const releasePath = join(
        responseGateDirectory,
        `release-${base.requestId}`,
      );
      const gateDeadline = Date.now() + responseGateTimeoutMs;
      while (!existsSync(releasePath) && Date.now() < gateDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!existsSync(releasePath)) {
        append({
          ...requestEvidence,
          event: "request-failed",
          error: "ResponseGateDeadline",
        });
        throw new Error("real provider response gate deadline exceeded");
      }
      append({
        ...requestEvidence,
        event: "response-released",
        status: response.status,
      });
      return response;
    }
    void clone
      .arrayBuffer()
      .then((bytes) => {
        const bodyText = safeValue(new TextDecoder().decode(bytes));
        append({
          ...requestEvidence,
          event: "response-complete",
          status: response.status,
          responseBodyBase64: Buffer.from(bodyText).toString("base64"),
        });
      })
      .catch((error) =>
        append({
          ...requestEvidence,
          event: "response-capture-failed",
          status: response.status,
          captureError: error instanceof Error ? error.name : "CaptureError",
        }),
      );
    return response;
  } catch (error) {
    append({
      ...requestEvidence,
      event: "request-failed",
      error: error instanceof Error ? error.name : "FetchError",
    });
    throw error;
  }
};
