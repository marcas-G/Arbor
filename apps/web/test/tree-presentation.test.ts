import type { TreeViewNode } from "@arbor/api-contracts";
import { describe, expect, it } from "vitest";
import { presentResponsibilityTree } from "../src/pages/tree/treePresentation.js";

const node = (id: string, parent: string | null): TreeViewNode =>
  ({
    workspaceId: id,
    parentWorkspaceId: parent,
    name: id,
    status: "idle",
    subtreeAttention: { attention: 0, actionRequired: 0 },
  }) as never;

describe("responsibility tree presentation", () => {
  it("uses explicit parent edges while preserving caller preorder", () => {
    const root = node("ws_root", null);
    const child = node("ws_child", "ws_root");
    const grandchild = node("ws_grandchild", "ws_child");
    const result = presentResponsibilityTree([root, child, grandchild]);
    expect(result?.root.workspaceId).toBe("ws_root");
    expect(result?.depths.get("ws_root")).toBe(0);
    expect(result?.depths.get("ws_child")).toBe(1);
    expect(result?.depths.get("ws_grandchild")).toBe(2);
  });

  it.each([
    ["zero root", [node("child", "missing")]],
    ["multiple root", [node("one", null), node("two", null)]],
    ["dangling parent", [node("root", null), node("child", "missing")]],
    ["cycle", [node("root", null), node("one", "two"), node("two", "one")]],
  ])("rejects a %s server hierarchy", (_label, nodes) => {
    expect(presentResponsibilityTree(nodes)).toBeNull();
  });
});
