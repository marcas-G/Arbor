import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTransportCore } from "../src/transport/core.js";
import type { HttpShell } from "../src/transport/http.js";
import { makeHttpShell } from "../src/transport/http.js";
import {
  startWebTransport,
  type WebTransportHandle,
} from "../src/transport/server.js";
import { makeWebSocketShell } from "../src/transport/websocket.js";

/** Native browser-style client (Node 24 global) — no transport import in
 * test territory (P12/P13 boundary: transport imports live only under the
 * apps transport source directory). */
type ClientSocket = {
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly onOpen: (handler: () => void) => void;
  readonly onMessage: (handler: (data: string) => void) => void;
};

const openClient = (port: number): Promise<ClientSocket> =>
  new Promise((resolveClient) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const wrap: ClientSocket = {
      send: (data) => {
        socket.send(data);
      },
      close: () => {
        socket.close();
      },
      onOpen: (handler) => {
        socket.onopen = () => {
          handler();
        };
      },
      onMessage: (handler) => {
        socket.onmessage = (event) => {
          handler(String(event.data));
        };
      },
    };
    socket.onopen = () => {
      resolveClient(wrap);
    };
  });

const fakeViews = {
  query: () =>
    Effect.succeed({
      data: { nodes: [] },
      watermark: 7,
      freshness: "Fresh" as const,
    }),
};

const fakeAuthenticator = {
  authenticate: () => Effect.succeed("user:alice" as never),
};

const fakeSubmission = {
  submit: () =>
    Effect.succeed({
      ok: true as const,
      status: 200,
      body: { commandId: "cmd_1", resolution: "Committed" },
    }),
};

const core = makeTransportCore({
  views: fakeViews as never,
  authenticator: fakeAuthenticator as never,
  submission: fakeSubmission as never,
});

const http: HttpShell = makeHttpShell(core);
const webSocket = makeWebSocketShell(core);

const fakeSql = {
  unsafe: () => Effect.succeed([{ watermark: 0 }]),
} as unknown as SqlClient;

let handle: WebTransportHandle;
let dist: string;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "arbor-web-e2e-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><title>arbor-e2e</title>",
  );
  writeFileSync(join(dist, "assets", "index-xyz.js"), "export {}");
  handle = await startWebTransport({
    http,
    webSocket,
    sql: fakeSql,
    staticRoot: dist,
    pollIntervalMs: 10_000,
  });
});

afterAll(async () => {
  await handle.close();
  rmSync(dist, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${handle.port}`;

describe("P13 web transport server (TR-W1/W2 binding)", () => {
  it("serves the SPA index same-origin at /", async () => {
    const response = await fetch(base());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("arbor-e2e");
  });

  it("serves hashed assets with immutable caching", async () => {
    const response = await fetch(`${base()}/assets/index-xyz.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("keeps the frozen API surface: POST /views/:view returns the DTO JSON", async () => {
    const response = await fetch(`${base()}/views/responsibility-tree`, {
      method: "POST",
      body: JSON.stringify({ projectId: "prj_1" }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      body: { data: { nodes: unknown[] } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.body.data.nodes).toEqual([]);
  });

  it("keeps the frozen API surface: POST /commands forwards the envelope", async () => {
    const response = await fetch(`${base()}/commands`, {
      method: "POST",
      body: JSON.stringify({
        commandType: "RecordDecision",
        commandId: "cmd_1",
      }),
    });
    const payload = (await response.json()) as {
      ok: boolean;
      body: { resolution: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.body.resolution).toBe("Committed");
  });

  it("WS request frames answer with the frozen shell response", async () => {
    const ws = await openClient(handle.port);
    const reply = new Promise<unknown>((resolveReply) => {
      ws.onMessage((data) => {
        resolveReply(JSON.parse(data));
      });
    });
    ws.send(
      JSON.stringify({
        kind: "view",
        view: "attention",
        request: { projectId: "prj_1" },
      }),
    );
    const payload = (await reply) as { ok: boolean; status: number };
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe(200);
    ws.close();
  });

  it("pushes invalidation frames (view + watermark, no payload) on watermark advance", async () => {
    const ws = await openClient(handle.port);
    const frames: unknown[] = [];
    ws.onMessage((data) => {
      frames.push(JSON.parse(data));
    });
    handle.fanout.publishWatermark(9);
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 150);
    });
    const invalidations = frames.filter(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { kind?: string }).kind === "invalidate",
    );
    expect(invalidations.length).toBeGreaterThan(0);
    for (const frame of invalidations) {
      expect(Object.keys(frame as object).sort()).toEqual([
        "kind",
        "view",
        "watermark",
      ]);
    }
    ws.close();
  });
});
