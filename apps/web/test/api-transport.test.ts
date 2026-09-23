import type { Problem } from "@arbor/api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchView, viewQueryKey } from "../src/api/transport.js";

/** W-00 — consolidated view transport (Query fetcher) behavior, ported from
 * the prototype fetch layers: envelope unwrap, Bearer, local degradation,
 * 401 escalation, abort passthrough. */

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const stubFetch = (impl: () => Promise<Response>) => {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api/transport fetchView", () => {
  it("unwraps the frozen QueryResult envelope to the DTO", async () => {
    const mock = stubFetch(() =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          status: 200,
          body: { value: { nodes: [] }, watermark: 3, lag: 0 },
        }),
      ),
    );
    const outcome = await fetchView(
      "responsibility-tree",
      { projectId: "prj_1" as never },
      { token: "tok" },
    );
    expect(outcome).toEqual({ ok: true, dto: { nodes: [] } });
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/views/responsibility-tree");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });

  it("returns the server Problem for error envelopes and escalates unauthenticated", async () => {
    const onUnauthenticated = vi.fn();
    const problem: Problem = {
      code: "auth/unauthenticated",
      category: "unauthenticated",
      message: "auth/unauthenticated",
      correlationId: null,
      retryDisposition: "non-retryable",
      safeDetails: {},
    };
    stubFetch(() =>
      Promise.resolve(jsonResponse(401, { ok: false, status: 401, problem })),
    );
    const outcome = await fetchView(
      "attention",
      { projectId: "prj_1" as never },
      { token: "tok", onUnauthenticated },
    );
    expect(outcome).toEqual({ ok: false, problem });
    expect(onUnauthenticated).toHaveBeenCalledWith(problem);
  });

  it("does not escalate non-auth problems", async () => {
    const onUnauthenticated = vi.fn();
    const problem: Problem = {
      code: "projection/stale",
      category: "stale",
      message: "projection/stale",
      correlationId: "c",
      retryDisposition: "retryable",
      safeDetails: {},
    };
    stubFetch(() =>
      Promise.resolve(jsonResponse(409, { ok: false, status: 409, problem })),
    );
    const outcome = await fetchView(
      "usage",
      { projectId: "prj_1" as never, groupBy: "project" },
      { token: "tok", onUnauthenticated },
    );
    expect(outcome).toEqual({ ok: false, problem });
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it("network failure degrades to a local retryable unavailable Problem", async () => {
    stubFetch(() => Promise.reject(new Error("down")));
    const outcome = await fetchView(
      "inbox-view",
      { workspaceId: "ws_1" as never },
      { token: "tok" },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem.code).toBe("view/fetch-failed");
      expect(outcome.problem.category).toBe("unavailable");
      expect(outcome.problem.retryDisposition).toBe("retryable");
    }
  });

  it("missing session token is a local problem (no fetch)", async () => {
    const mock = stubFetch(() => Promise.resolve(jsonResponse(200, {})));
    const outcome = await fetchView(
      "attention",
      { projectId: "p" as never },
      {
        token: null,
      },
    );
    expect(outcome.ok).toBe(false);
    expect(mock.mock.calls.length).toBe(0);
  });

  it("rethrows AbortError (Query cancellation semantics)", async () => {
    stubFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await expect(
      fetchView("attention", { projectId: "p" as never }, { token: "t" }),
    ).rejects.toThrow("aborted");
  });

  it("viewQueryKey anchors the canonical ['view', viewId, request] key", () => {
    expect(viewQueryKey("attention", { projectId: "p" as never })).toEqual([
      "view",
      "attention",
      { projectId: "p" },
    ]);
  });
});
