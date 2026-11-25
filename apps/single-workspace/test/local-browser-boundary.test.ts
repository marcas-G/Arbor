import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import { sendLocalBoundaryRequest as send } from "../../../tests/functional/support/local-boundary-client.js";
import type { ModelSetup } from "../src/model-setup.js";
import type { HttpShell } from "../src/transport/http.js";
import {
  startWebTransport,
  type WebTransportHandle,
} from "../src/transport/server.js";
import type { WebSocketShell } from "../src/transport/websocket.js";

let handle: WebTransportHandle | undefined;
let handled = 0;
const response = () =>
  Effect.sync(() => {
    handled += 1;
    return { ok: true as const, status: 200, body: {} };
  });
const http: HttpShell = {
  authorizeSensitiveRead: () => Effect.succeed(null),
  handle: response,
  handleAuthorizedView: response,
};
const webSocket: WebSocketShell = {
  authorizeViewFrame: () => Effect.succeed(null),
  handleFrame: response,
  handleAuthorizedViewFrame: response,
};
const start = async (modelSetup?: ModelSetup) => {
  handled = 0;
  handle = await startWebTransport({
    http,
    webSocket,
    authenticatorConfigured: false,
    sql: { unsafe: () => Effect.succeed([]) } as unknown as SqlClient,
    projectDirectory: { list: () => Effect.succeed([]) },
    host: "127.0.0.1",
    port: 0,
    ...(modelSetup === undefined ? {} : { modelSetup }),
  });
  return handle;
};
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("local-user browser boundary", () => {
  it("blocks HTTP and WebSocket work entry until a real model is configured", async () => {
    const { port } = await start({
      configured: false,
      status: () => ({ configured: false, model: null }),
      save: async () => {},
      requestRestart: () => {},
    });
    expect(await send(port, "/commands")).toBe(503);
    expect(await send(port, "/views/work-detail")).toBe(503);
    expect(await send(port, "/ws", {}, true)).toBe(503);
    const status = await fetch(`http://127.0.0.1:${port}/model-setup`).then(
      (response) => response.json(),
    );
    expect(status).toEqual({ configured: false, model: null });
    expect(handled).toBe(0);
  });
  it("allows same-origin browser commands and native clients without Origin", async () => {
    const { port } = await start();
    expect(
      await send(port, "/commands", { origin: `http://127.0.0.1:${port}` }),
    ).toBe(200);
    expect(await send(port, "/commands")).toBe(200);
    expect(handled).toBe(2);
  });

  it("rejects foreign, opaque and malformed origins before dispatching any command or view", async () => {
    const { port } = await start();
    for (const origin of [
      "https://attacker.example",
      "null",
      "malformed",
      `http://127.0.0.1:${port + 1}`,
      `http://127.0.0.1:${port}/`,
    ]) {
      for (const path of [
        "/commands",
        "/views/work-detail",
        "/project-directories",
      ]) {
        expect(await send(port, path, { origin })).toBe(403);
      }
    }
    expect(
      await send(port, "/commands", { "sec-fetch-site": "cross-site" }),
    ).toBe(403);
    expect(handled).toBe(0);
  });

  it("rejects DNS rebinding and does not trust forwarded host or origin", async () => {
    const { port } = await start();
    expect(
      await send(port, "/commands", {
        host: `rebind.attacker.example:${port}`,
        origin: `http://rebind.attacker.example:${port}`,
        "x-forwarded-host": `127.0.0.1:${port}`,
      }),
    ).toBe(403);
    expect(await send(port, "/commands", { host: "127.0.0.1:1" })).toBe(403);
    expect(handled).toBe(0);
  });

  it("rejects hostile WebSocket upgrades without admitting an invalidation subscriber", async () => {
    const server = await start();
    for (const origin of ["https://attacker.example", "null"]) {
      expect(await send(server.port, "/ws", { origin }, true)).toBe(403);
    }
    expect(
      await send(
        server.port,
        "/ws",
        {
          host: `rebind.attacker.example:${server.port}`,
          origin: `http://rebind.attacker.example:${server.port}`,
        },
        true,
      ),
    ).toBe(403);
    expect(server.webSocketSubscriberCount()).toBe(0);
    expect(handled).toBe(0);
  });

  it("preserves same-origin and native WebSocket upgrades", async () => {
    const { port } = await start();
    expect(
      await send(port, "/ws", { origin: `http://127.0.0.1:${port}` }, true),
    ).toBe(101);
    expect(await send(port, "/ws", {}, true)).toBe(101);
  });
});
