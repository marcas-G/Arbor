/**
 * W-00 — the consolidated view transport (single Query fetcher).
 *
 * Merges the prototype's two fetch layers (data/client.ts +
 * session/useSessionFetch.ts) into one module consumed by TanStack Query:
 * POST /views/:view with Bearer; unwrap the frozen QueryResult envelope
 * ({value, watermark, lag}); server Problem wins; network/non-JSON degrade
 * to a local `unavailable` Problem; category "unauthenticated" escalates to
 * the global session gate. TanStack Query is the ONLY server-state cache.
 */
import type {
  Problem,
  ViewRequestMap,
  ViewResponseMap,
} from "@arbor/api-contracts";

export type ViewOutcome<Res> =
  | { readonly ok: true; readonly dto: Res }
  | { readonly ok: false; readonly problem: Problem };

const localProblem = (code: string): Problem => ({
  code,
  category: "unavailable",
  message: code,
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {},
});

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

export interface ViewFetchOptions {
  readonly token: string | null;
  readonly signal?: AbortSignal | undefined;
  readonly onUnauthenticated?: ((problem: Problem) => void) | undefined;
}

export const fetchView = async <View extends keyof ViewRequestMap & string>(
  view: View,
  request: ViewRequestMap[View],
  options: ViewFetchOptions,
): Promise<ViewOutcome<ViewResponseMap[View]>> => {
  if (options.token === null) {
    return { ok: false, problem: localProblem("view/no-session-token") };
  }
  let response: Response;
  try {
    response = await fetch(`/views/${view}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(request),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { ok: false, problem: localProblem("view/fetch-failed") };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, problem: localProblem("view/non-json-body") };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if (record.ok === true && "body" in record) {
      const body = record.body;
      const dto =
        typeof body === "object" &&
        body !== null &&
        "value" in body &&
        typeof (body as Record<string, unknown>).watermark === "number"
          ? (body as { readonly value: unknown }).value
          : body;
      return { ok: true, dto: dto as ViewResponseMap[View] };
    }
    if (record.ok === false && isProblem(record.problem)) {
      if (record.problem.category === "unauthenticated") {
        options.onUnauthenticated?.(record.problem);
      }
      return { ok: false, problem: record.problem };
    }
  }
  return { ok: false, problem: localProblem("view/unexpected-body") };
};

/** The canonical query key root for all view queries. */
export const viewQueryKey = <View extends keyof ViewRequestMap & string>(
  view: View,
  request: ViewRequestMap[View],
): readonly [string, View, ViewRequestMap[View]] => ["view", view, request];
