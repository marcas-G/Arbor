import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ConversationProgressHub,
  createConversationProgressHub,
} from "../src/transport/conversation-progress.js";
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
  authenticate: () => Effect.succeed("user:local" as never),
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
  unsafe: (query: string) =>
    query.includes("human_messages")
      ? Effect.succeed([{ human_principal: "user:local" }])
      : Effect.succeed([{ watermark: 0 }]),
} as unknown as SqlClient;

let handle: WebTransportHandle;
let dist: string;
let progress: ConversationProgressHub;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "arbor-web-e2e-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><title>arbor-e2e</title>",
  );
  writeFileSync(join(dist, "assets", "index-xyz.js"), "export {}");
  progress = createConversationProgressHub();
  handle = await startWebTransport({
    http,
    webSocket,
    authenticator: fakeAuthenticator,
    authenticatorConfigured: true,
    conversationProgress: progress,
    sql: fakeSql,
    projectDirectory: {
      list: () =>
        Effect.succeed([
          {
            projectId: "prj_1" as never,
            name: "Project One",
            lifecycle: "Open" as const,
            rootWorkspaceId: "ws_1" as never,
            revision: 2 as never,
            updatedAt: "t",
          },
        ]),
    },
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

  it("serves the local project directory through its injected read port", async () => {
    const response = await fetch(`${base()}/projects`, {
      headers: { Authorization: "Bearer local" },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      body: { projects: ReadonlyArray<{ name: string; revision: number }> };
    };
    expect(payload.body.projects).toEqual([
      expect.objectContaining({ name: "Project One", revision: 2 }),
    ]);
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

  it("streams authenticated conversation progress without changing transcript DTOs", async () => {
    progress.publish("msg_1", {
      type: "delta",
      executionId: "exe_1",
      providerTurnId: "ptn_1",
      attemptNo: 0,
      text: "hello",
    });
    progress.publish("msg_1", { type: "settled", executionId: "exe_1" });
    const response = await fetch(`${base()}/conversation-progress/msg_1`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"type":"delta"');
    expect(body).toContain('"text":"hello"');
    expect(body).toContain('"type":"settled"');
  });

  it("keeps the SSE listener alive after the GET request has completed", async () => {
    const response = await fetch(`${base()}/conversation-progress/msg_live`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    if (response.body === null) {
      throw new Error("expected an SSE response body");
    }

    const reader = response.body.getReader();
    const pendingRead = reader.read();
    progress.publish("msg_live", {
      type: "delta",
      executionId: "exe_live",
      providerTurnId: "ptn_live",
      attemptNo: 0,
      text: "live delta",
    });
    const liveChunk = await pendingRead;
    expect(new TextDecoder().decode(liveChunk.value)).toContain(
      '"text":"live delta"',
    );

    progress.publish("msg_live", { type: "settled", executionId: "exe_live" });
    await reader.read();
  });
});
