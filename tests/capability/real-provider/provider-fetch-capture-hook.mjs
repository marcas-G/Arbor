import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const captureFile = process.env.ARBOR_PUBLIC_S1_CAPTURE_FILE;
const endpointValue = process.env.ARBOR_PUBLIC_S1_CAPTURE_ENDPOINT;
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

  const body = typeof init?.body === "string" ? init.body : undefined;
  let request;
  if (body !== undefined) {
    try {
      request = JSON.parse(body);
    } catch {
      request = { unparsedBody: body };
    }
  }
  const requestEvidence = request === undefined ? base : { ...base, request };

  try {
    const response = await originalFetch(input, init);
    const headers = Object.fromEntries(
      ["content-type", "server", "x-request-id"]
        .map((name) => [name, response.headers.get(name)])
        .filter((entry) => entry[1] !== null),
    );
    const clone = response.clone();
    void clone
      .arrayBuffer()
      .then((bytes) => {
        const bodyText = safeValue(new TextDecoder().decode(bytes));
        append({
          ...requestEvidence,
          event: "response-complete",
          status: response.status,
          responseHeaders: headers,
          responseBodyBase64: Buffer.from(bodyText).toString("base64"),
        });
      })
      .catch((error) =>
        append({
          ...requestEvidence,
          event: "response-capture-failed",
          status: response.status,
          responseHeaders: headers,
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
