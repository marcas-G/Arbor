/**
 * P13 `05` §3 submission face: every human-actionable form POSTs its envelope
 * to `/commands`. The transport result envelope ({ok,status,body|problem}) is
 * mirrored here. Fetch failure / non-JSON / unexpected body degrade to a local
 * `transport/unavailable` Problem (category `unavailable`, retryable — retry
 * MUST reuse the same commandId, owned by the form state, not this module).
 */
import type { Problem } from "@arbor/api-contracts";
import type { ExternalCommandEnvelope } from "./envelope.js";

export interface CommandReceiptView {
  readonly commandId: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result?: unknown;
  readonly rejection?: string;
}

export type TransportResponse<A> =
  | { readonly ok: true; readonly status: number; readonly body: A }
  | { readonly ok: false; readonly status: number; readonly problem: Problem };

const unavailableProblem = (detail: string): Problem => ({
  code: "transport/unavailable",
  category: "unavailable",
  message: "命令提交通道不可用",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: { detail },
});

const isReceipt = (value: unknown): value is CommandReceiptView => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.commandId === "string" &&
    (record.resolution === "Committed" ||
      record.resolution === "TerminalRejected")
  );
};

const isProblem = (value: unknown): value is Problem => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.category === "string" &&
    typeof record.message === "string"
  );
};

export async function submitCommand(
  envelope: ExternalCommandEnvelope,
  token?: string | undefined,
): Promise<TransportResponse<CommandReceiptView>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch("/commands", {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      problem: unavailableProblem(`fetch failed: ${String(error)}`),
    };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      problem: unavailableProblem("non-JSON response body"),
    };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (record.ok === true && isReceipt(record.body)) {
      return { ok: true, status: response.status, body: record.body };
    }
    if (record.ok === false && isProblem(record.problem)) {
      return {
        ok: false,
        status: response.status,
        problem: record.problem,
      };
    }
  }
  return {
    ok: false,
    status: response.status,
    problem: unavailableProblem("unexpected response body"),
  };
}
