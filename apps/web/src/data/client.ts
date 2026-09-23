/**
 * P13-006 view fetch face: POST /views/:view with the request JSON; the
 * transport envelope ({ok,status,body|problem}) resolves to a ViewOutcome.
 * Failure mapping (frozen `05` §3): HTTP status → the server Problem wins; a
 * network failure / non-JSON body / unexpected envelope degrades to a LOCAL
 * Problem (message=code, correlationId=null, safeDetails={}); network failure
 * is transport/unavailable, category `unavailable`, retryable. Pure transport
 * — no cache awareness lives here.
 */
import type {
  Problem,
  ViewId,
  ViewRequestMap,
  ViewResponseMap,
} from "@arbor/api-contracts";

export type ViewOutcome<V extends ViewId> =
  | { readonly ok: true; readonly dto: ViewResponseMap[V] }
  | { readonly ok: false; readonly problem: Problem };

export interface FetchViewOptions {
  readonly token?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

const localProblem = (
  code: string,
  category: string,
  retryDisposition: string,
): Problem => ({
  code,
  category,
  message: code,
  correlationId: null,
  retryDisposition,
  safeDetails: {},
});

const unavailable = (): Problem =>
  localProblem("transport/unavailable", "unavailable", "retryable");

const invalidResponse = (): Problem =>
  localProblem("transport/invalid-response", "unavailable", "retryable");

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

export async function fetchView<V extends ViewId>(
  view: V,
  request: ViewRequestMap[V],
  opts?: FetchViewOptions,
): Promise<ViewOutcome<V>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts?.token !== undefined) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  };
  if (opts?.signal !== undefined) {
    init.signal = opts.signal;
  }
  let response: Response;
  try {
    response = await fetch(`/views/${view}`, init);
  } catch {
    return { ok: false, problem: unavailable() };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, problem: invalidResponse() };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (record.ok === true && "body" in record) {
      return { ok: true, dto: record.body as ViewResponseMap[V] };
    }
    if (record.ok === false && isProblem(record.problem)) {
      return { ok: false, problem: record.problem };
    }
  }
  return { ok: false, problem: invalidResponse() };
}
