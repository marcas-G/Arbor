/**
 * W-00 ② tests — project-scoped route parse/format round-trip + Session
 * memory role (§2.1A: URL is the deep-link authority).
 */
import { describe, expect, it } from "vitest";
import {
  formatRoute,
  parseRoute,
  type Route,
  WORKSPACE_TABS,
} from "../src/api/router.js";

const ROUTE_NAMES = {
  "project-overview": true,
  tree: true,
  queue: true,
  attention: true,
  usage: true,
  settings: true,
  workspace: true,
  work: true,
} as const satisfies Record<Route["name"], true>;

const routes: ReadonlyArray<Route> = [
  { name: "project-overview", projectId: "prj_1" },
  { name: "tree", projectId: "prj_1" },
  { name: "queue", projectId: "prj_1" },
  { name: "attention", projectId: "prj_1" },
  { name: "usage", projectId: "prj_1" },
  { name: "settings", projectId: "prj_1" },
  {
    name: "workspace",
    projectId: "prj_1",
    workspaceId: "ws_1",
    tab: "overview",
  },
  {
    name: "workspace",
    projectId: "prj_1",
    workspaceId: "ws_1",
    tab: "dependencies",
  },
  {
    name: "workspace",
    projectId: "prj_1",
    workspaceId: "ws_1",
    tab: "verification",
  },
  {
    name: "workspace",
    projectId: "prj_1",
    workspaceId: "ws_1",
    tab: "transcript",
  },
  {
    name: "workspace",
    projectId: "prj_1",
    workspaceId: "ws_1",
    tab: "inbox",
  },
  {
    name: "workspace",
    projectId: "prj_1",
    workspaceId: "ws_1",
    tab: "conversation",
  },
  { name: "work", projectId: "prj_1", workspaceId: "ws_1", workId: "wrk_1" },
];

describe("W-00 project-scoped typed router", () => {
  it("parse ∘ format is identity for every product route", () => {
    expect(new Set(routes.map((route) => route.name))).toEqual(
      new Set(Object.keys(ROUTE_NAMES)),
    );
    for (const route of routes) {
      const path = formatRoute(route);
      expect(parseRoute(path), path).toEqual(route);
      expect(parseRoute(path)?.projectId, path).toBe(route.projectId);
    }
  });

  it("workspace default tab formats bare and parses back as overview", () => {
    const path = formatRoute({
      name: "workspace",
      projectId: "prj_1",
      workspaceId: "ws_1",
      tab: "overview",
    });
    expect(path).toBe("/p/prj_1/workspace/ws_1");
    expect(parseRoute(path)).toEqual({
      name: "workspace",
      projectId: "prj_1",
      workspaceId: "ws_1",
      tab: "overview",
    });
  });

  it("exactly the six frozen workspace tabs parse (P14 TR-C)", () => {
    expect(WORKSPACE_TABS).toEqual([
      "overview",
      "dependencies",
      "verification",
      "transcript",
      "inbox",
      "conversation",
    ]);
    expect(parseRoute("/p/prj_1/workspace/ws_1/conversation")).toEqual({
      name: "workspace",
      projectId: "prj_1",
      workspaceId: "ws_1",
      tab: "conversation",
    });
  });

  it("rejects non-product paths (null, callers render not-found)", () => {
    expect(parseRoute("/")).toBeNull();
    expect(parseRoute("/tree")).toBeNull();
    expect(parseRoute("/workspace/ws_1")).toBeNull();
    expect(parseRoute("/p/prj_1/unknown")).toBeNull();
    expect(parseRoute("/p/prj_1/workspace/ws_1/chatty")).toBeNull();
    expect(parseRoute("/p/prj_1/workspace/ws_1/work")).toBeNull();
    // empty segments are filtered, so "/p//tree" is "/p/tree" (a valid
    // project named "tree"); genuinely invalid ids fail the charset test
    expect(parseRoute("/p/bad id/tree")).toBeNull();
    expect(parseRoute("/p/bad/id/tree")).toBeNull();
  });

  it("strips query strings before parsing", () => {
    expect(parseRoute("/p/prj_1/tree?depth=2")).toEqual({
      name: "tree",
      projectId: "prj_1",
    });
  });

  it("every route carries the projectId (deep-link authority)", () => {
    for (const route of routes) {
      expect(formatRoute(route).startsWith(`/p/${route.projectId}`)).toBe(true);
    }
  });
});
