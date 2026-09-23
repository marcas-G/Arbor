/**
 * P13-006 unit coverage: fetchView transport mapping (ok envelope → dto,
 * server Problem envelope wins, network failure → local transport/unavailable
 * retryable, non-JSON → local transport/invalid-response) + viewStore state
 * discipline (beginRefetch → loading; resolve replaces stale wholesale;
 * invalidate only marks stale and keeps dto; failure keeps prior dto and
 * records the problem; listeners fire only on real change with a stable
 * getSnapshot reference).
 */

import type { AttentionRes, Problem } from "@arbor/api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchView } from "../src/data/client.js";
import { createViewStore, entryKeyOf } from "../src/data/viewStore.js";

const id = (value: string): never => value as never;

const jsonResponse = (status: number, body: unknown) => ({
  status,
  json: async () => body,
});

const headersOf = (init: RequestInit): Record<string, string> =>
  init.headers as unknown as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchView", () => {
  it("POSTs request JSON to /views/:view and returns dto on ok envelope", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { ok: true, status: 200, body: { rows: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await fetchView("attention", { projectId: id("p-1") });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dto).toEqual({ rows: [] });
    }
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) {
      return;
    }
    const [url, init] = firstCall;
    expect(url).toBe("/views/attention");
    expect(init.method).toBe("POST");
    expect(headersOf(init)["content-type"]).toBe("application/json");
    expect(headersOf(init).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ projectId: id("p-1") });
    expect(init.signal).toBeUndefined();
  });

  it("adds Authorization header when token given, forwards signal, null dto passes through", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(200, { ok: true, status: 200, body: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const outcome = await fetchView(
      "current-work",
      { workspaceId: id("w-1") },
      { token: "t-1", signal: controller.signal },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dto).toBeNull();
    }
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) {
      return;
    }
    const [url, init] = firstCall;
    expect(url).toBe("/views/current-work");
    expect(headersOf(init).Authorization).toBe("Bearer t-1");
    expect(init.signal).toBe(controller.signal);
  });

  it("HTTP Problem envelope wins: server problem passes through verbatim", async () => {
    const problem: Problem = {
      code: "view/not-found",
      category: "invalid-request",
      message: "视图不存在",
      correlationId: "c-1",
      retryDisposition: "non-retryable",
      safeDetails: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) =>
        jsonResponse(404, { ok: false, status: 404, problem }),
      ),
    );
    const outcome = await fetchView("workspace-detail", {
      workspaceId: id("w-missing"),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem.code).toBe("view/not-found");
      expect(outcome.problem.category).toBe("invalid-request");
      expect(outcome.problem.correlationId).toBe("c-1");
      expect(outcome.problem.retryDisposition).toBe("non-retryable");
    }
  });

  it("network failure → local transport/unavailable retryable Problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) => {
        throw new Error("offline");
      }),
    );
    const outcome = await fetchView("usage", {
      projectId: id("p-1"),
      groupBy: "workspace",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem.code).toBe("transport/unavailable");
      expect(outcome.problem.category).toBe("unavailable");
      expect(outcome.problem.retryDisposition).toBe("retryable");
      expect(outcome.problem.message).toBe("transport/unavailable");
      expect(outcome.problem.correlationId).toBeNull();
      expect(outcome.problem.safeDetails).toEqual({});
    }
  });

  it("non-JSON body → local transport/invalid-response retryable Problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) => ({
        status: 502,
        json: async () => {
          throw new Error("bad body");
        },
      })),
    );
    const outcome = await fetchView("transcript", {
      workspaceId: id("w-1"),
      limit: 10,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.problem.code).toBe("transport/invalid-response");
      expect(outcome.problem.category).toBe("unavailable");
      expect(outcome.problem.retryDisposition).toBe("retryable");
      expect(outcome.problem.correlationId).toBeNull();
      expect(outcome.problem.safeDetails).toEqual({});
    }
  });
});

describe("viewStore", () => {
  const key = entryKeyOf("attention", '{"projectId":"p-1"}');

  it("beginRefetch creates a loading entry; resolve replaces it with fresh", () => {
    const store = createViewStore();
    expect(store.getEntry(key)).toBeUndefined();
    store.beginRefetch(key);
    const loading = store.getEntry(key);
    expect(loading?.viewId).toBe("attention");
    expect(loading?.requestKey).toBe('{"projectId":"p-1"}');
    expect(loading?.state).toBe("loading");
    expect(loading?.dto).toBeUndefined();
    store.resolve(key, { ok: true, dto: { rows: [] } });
    expect(store.getEntry(key)?.state).toBe("fresh");
  });

  it("invalidate only marks stale (dto retained, watermark stamped); resolve overwrites stale", () => {
    const store = createViewStore();
    store.beginRefetch(key);
    const dtoA: AttentionRes = { rows: [] };
    store.resolve(key, { ok: true, dto: dtoA });
    store.invalidate("attention", 5);
    const stale = store.getEntry(key);
    expect(stale?.state).toBe("stale");
    expect(stale?.dto).toEqual(dtoA);
    expect(stale?.watermark).toBe(5);
    const dtoB: AttentionRes = {
      rows: [
        {
          source: "Deadlock",
          severity: "Attention",
          targetWorkspaceId: id("w-1"),
          dedupKey: "d-1",
          summaryRef: "b",
          occurredAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    };
    store.resolve(key, { ok: true, dto: dtoB });
    const fresh = store.getEntry(key);
    expect(fresh?.state).toBe("fresh");
    expect(fresh?.dto).toEqual(dtoB);
    expect(fresh?.watermark).toBe(5);
  });

  it("failed resolve keeps prior dto, records problem, marks stale", () => {
    const store = createViewStore();
    store.beginRefetch(key);
    const dto: AttentionRes = { rows: [] };
    store.resolve(key, { ok: true, dto });
    const problem: Problem = {
      code: "transport/unavailable",
      category: "unavailable",
      message: "transport/unavailable",
      correlationId: null,
      retryDisposition: "retryable",
      safeDetails: {},
    };
    store.resolve(key, { ok: false, problem });
    const failed = store.getEntry(key);
    expect(failed?.state).toBe("stale");
    expect(failed?.dto).toEqual(dto);
    expect(failed?.problem?.code).toBe("transport/unavailable");
  });

  it("listeners fire only on real change; getSnapshot reference is stable", () => {
    const store = createViewStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const empty = store.getEntries();
    store.invalidate("attention", 1);
    expect(store.getEntries()).toBe(empty);
    expect(listener).not.toHaveBeenCalled();
    store.beginRefetch(key);
    expect(listener).toHaveBeenCalledTimes(1);
    const created = store.getEntries();
    store.invalidate("usage", 2);
    expect(store.getEntries()).toBe(created);
    expect(listener).toHaveBeenCalledTimes(1);
    store.beginRefetch(key);
    expect(store.getEntries()).toBe(created);
    expect(listener).toHaveBeenCalledTimes(1);
    store.invalidate("attention", 7);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getEntries()).not.toBe(created);
    unsubscribe();
    store.invalidate("attention", 9);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
