import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  isViewId,
  makeCliShell,
  makeHttpShell,
  makeStaticAuthenticator,
  makeTransportCore,
  makeWebShell,
  makeWebSocketShell,
  SEARCH_TRANSPORT_BINDING,
} from "../../apps/single-workspace/src/transport/index.js";
import type {
  QueryResult,
  TreeViewRes,
} from "../../packages/api-contracts/src/index.js";
import {
  Principal,
  parse,
  VIEW_IDS,
} from "../../packages/domain/dist/index.js";
import {
  COMMAND,
  HUMAN,
  PROJECT,
  stubViews,
  treeDto,
  treeResult,
} from "./transport-support.js";

describe("P12-010 transport shells render api-contracts DTOs (EC-11)", () => {
  const core = makeTransportCore({
    views: stubViews(),
    authenticator: makeStaticAuthenticator({
      "human-token": HUMAN,
      "local-read-token": parse(Principal)("user:local"),
    }),
    submission: {
      submit: () =>
        Effect.succeed({
          ok: true as const,
          status: 200,
          body: { commandId: COMMAND, resolution: "Committed" as const },
        }),
    },
  });
  const http = makeHttpShell(core);
  const ws = makeWebSocketShell(core);
  const cli = makeCliShell(core);
  const web = makeWebShell(core);

  it("HTTP / WS / CLI render the same frozen DTO unchanged", async () => {
    const viaHttp = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/responsibility-tree",
        authorization: "Bearer local-read-token",
        body: { projectId: PROJECT },
      }),
    );
    const viaWs = await Effect.runPromise(
      ws.handleFrame({
        kind: "view",
        token: "local-read-token",
        view: "responsibility-tree",
        request: { projectId: PROJECT },
      }),
    );
    const viaCli = await Effect.runPromise(
      cli.run([
        "view",
        "responsibility-tree",
        JSON.stringify({ projectId: PROJECT }),
      ]),
    );
    for (const response of [viaHttp, viaWs, viaCli]) {
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual(treeResult);
        const body = response.body as QueryResult<TreeViewRes>;
        expect(body.value).toEqual(treeDto);
        expect(Object.keys(body.value.nodes[0] ?? {})).toEqual([
          "workspaceId",
          "parentWorkspaceId",
          "name",
          "status",
          "subtreeAttention",
        ]);
      }
    }
  });

  it("web shell renders the DTO as an embedded JSON island (no reinterpretation)", async () => {
    const rendered = await Effect.runPromise(
      web.renderView("responsibility-tree", { projectId: PROJECT }),
    );
    expect(rendered.contentType).toBe("text/html; charset=utf-8");
    expect(rendered.html).toContain(JSON.stringify(treeResult));
  });

  it("failures are presented as the frozen six-field Problem DTO", async () => {
    const response = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/attention",
        authorization: "Bearer local-read-token",
        body: { projectId: PROJECT },
      }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(Object.keys(response.problem).sort()).toEqual([
        "category",
        "code",
        "correlationId",
        "message",
        "retryDisposition",
        "safeDetails",
      ]);
      expect(response.problem.code).toBe("projection/stale");
      expect(response.problem.category).toBe("stale");
      expect(response.status).toBe(409);
    }
    const unknown = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/does-not-exist",
        authorization: "Bearer local-read-token",
        body: {},
      }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.problem.code).toBe("transport/unknown-view");
    }
  });

  it("Search is an out-of-v1 deferral: no Search surface or view id", () => {
    expect(SEARCH_TRANSPORT_BINDING.implemented).toBe(false);
    expect(SEARCH_TRANSPORT_BINDING.owner).toBe("P10");
    expect(SEARCH_TRANSPORT_BINDING.viewSemantics).toBe("unfrozen");
    expect(isViewId("search")).toBe(false);
    expect((VIEW_IDS as ReadonlyArray<string>).includes("search")).toBe(false);
  });
});
