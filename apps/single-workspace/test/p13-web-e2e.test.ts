import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Principal, parse } from "@arbor/domain";
import { Effect, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/composition.js";
import {
  ProductionDaemonService,
  TransportBoundary,
} from "../src/production.js";
import { makeStaticAuthenticator } from "../src/transport/auth.js";
import {
  startWebTransport,
  type WebTransportHandle,
} from "../src/transport/server.js";
import { createProjectPayloadShape, p13Id } from "./p13-e2e-fixtures.js";

/**
 * P13 `06` EC-11 — the story-§1 mechanical path against the REAL slice
 * composition: same-origin static hosting + frozen API + WS invalidation.
 * Node fetch / native WebSocket play the browser role (same-origin HTTP/WS
 * protocol correctness; the jsdom-rendered client is covered by the
 * apps/web suites).
 */

const TOKEN = "tok_p13_e2e";
const HUMAN = parse(Principal)("user:human");
const READ_TOKEN = "tok_p13_local_read";

let handle: WebTransportHandle;
let dir: string;
let dist: string;
let runConsumers: (() => Promise<void>) | undefined;
let startupError: unknown;
let programFiber: ReturnType<typeof Effect.runFork> | undefined;

const shutdown: Array<() => Promise<void>> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "arbor-p13-e2e-"));
  dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><title>arbor-p13</title>",
  );
  writeFileSync(join(dist, "assets", "index-e2e.js"), "export {}");

  const program = Effect.scoped(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        const boundary = yield* TransportBoundary;
        const sql = yield* SqlClient;
        const deployment = yield* ProductionDaemonService;
        yield* deployment.daemon.start;
        runConsumers = () =>
          Effect.runPromise(
            Effect.provide(
              Effect.gen(function* () {
                yield* deployment.daemon.pollConsumers;
              }),
              buildSingleWorkspaceLayer({
                databaseFile: join(dir, "slice.db"),
                authenticator: makeStaticAuthenticator({
                  [TOKEN]: HUMAN,
                  [READ_TOKEN]: parse(Principal)("user:local"),
                }),
                governance: {
                  authenticatedHumans: [HUMAN],
                  directParentOf: [],
                },
              }),
            ),
          ).catch(() => undefined);
        handle = yield* Effect.promise(() =>
          startWebTransport({
            http: boundary.http,
            webSocket: boundary.webSocket,
            authenticator: boundary.authenticator,
            authenticatorConfigured: true,
            sql,
            projectDirectory: { list: () => Effect.succeed([]) },
            staticRoot: dist,
            pollIntervalMs: 60_000,
          }),
        );
        shutdown.push(() => handle.close());
        // hold the scope open for the whole suite (layers close at process end)
        yield* Effect.promise(() => new Promise<never>(() => undefined));
      }),
      buildSingleWorkspaceLayer({
        databaseFile: join(dir, "slice.db"),
        authenticator: makeStaticAuthenticator({
          [TOKEN]: HUMAN,
          [READ_TOKEN]: parse(Principal)("user:local"),
        }),
        governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
      }),
    ),
  );
  programFiber = Effect.runFork(program);
  for (
    let i = 0;
    i < 200 && handle === undefined && startupError === undefined;
    i += 1
  ) {
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 50);
    });
  }
  expect(
    startupError,
    `composition startup failed: ${String(startupError)}`,
  ).toBeUndefined();
  expect(handle).toBeDefined();
}, 30_000);

afterAll(async () => {
  for (const stop of shutdown.reverse()) {
    await stop();
  }
  if (programFiber !== undefined) {
    await Effect.runPromise(Fiber.interrupt(programFiber));
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const base = () => `http://127.0.0.1:${handle.port}`;
const authHeaders = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

describe("P13 EC-11 e2e — real composition, story path", () => {
  it("serves the SPA and assets same-origin", async () => {
    const index = await fetch(base());
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("arbor-p13");
    const asset = await fetch(`${base()}/assets/index-e2e.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("TR-W2 SPA fallback: client-route deep links serve index.html, not an API problem", async () => {
    const deep = await fetch(`${base()}/p/prj_1/workspace/ws_1/transcript`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");
    expect(await deep.text()).toContain("arbor-p13");
  });

  it("story §1: CreateProject via /commands (external human governance) lands Committed", async () => {
    const project = createProjectPayloadShape("story");
    const response = await fetch(`${base()}/commands`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        commandType: "CreateProject",
        commandId: p13Id("cmd"),
        projectId: project.projectId,
        actor: "user:human",
        issuedAt: new Date().toISOString(),
        payload: project.payload,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      body: { resolution: string };
    };
    expect(body.ok).toBe(true);
    expect(body.body.resolution).toBe("Committed");
  });

  it("story §1: the responsibility-tree view renders the created root workspace", async () => {
    await runConsumers?.();
    const project = createProjectPayloadShape("story");
    const response = await fetch(`${base()}/views/responsibility-tree`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${READ_TOKEN}`,
      },
      body: JSON.stringify({ projectId: project.projectId }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      ok: boolean;
      body: { value: { nodes: Array<{ name: string }> } };
    };
    expect(result.ok).toBe(true);
    expect(result.body.value.nodes.length).toBeGreaterThan(0);
  });

  it("rejects unauthenticated commands with the frozen Problem", async () => {
    const response = await fetch(`${base()}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandType: "CreateProject",
        commandId: "cmd_x",
      }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      ok: boolean;
      problem: { code: string; category: string };
    };
    expect(body.problem.code).toBe("auth/unauthenticated");
    expect(body.problem.category).toBe("unauthenticated");
  });

  it("TR-W1: WS invalidation pushes after a commit advances the journal watermark", async () => {
    expect(handle).toBeDefined();
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`);
    await new Promise<void>((resolveOpen) => {
      ws.onopen = () => {
        resolveOpen();
      };
    });
    const frames: unknown[] = [];
    ws.onmessage = (event) => {
      frames.push(JSON.parse(String(event.data)));
    };

    const project = createProjectPayloadShape("ws");
    const response = await fetch(`${base()}/commands`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        commandType: "CreateProject",
        commandId: p13Id("cmd"),
        projectId: project.projectId,
        actor: "user:human",
        issuedAt: new Date().toISOString(),
        payload: project.payload,
      }),
    });
    expect(response.status).toBe(200);
    await handle.pollNow();

    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 250);
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
      expect((frame as { watermark: number }).watermark).toBeGreaterThan(0);
    }
    ws.close();
  });
});
