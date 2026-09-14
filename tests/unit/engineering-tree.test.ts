import { describe, expect, it } from "vitest";
import {
  DEPTH_CAP,
  type TreeNode,
  validateAddChild,
  validateTree,
} from "../../src/domain/engineering-tree.js";

const root = (prefixes = ["."]): TreeNode => ({
  workspaceId: "root-ws",
  kind: "root",
  writablePrefixes: prefixes,
});
const child = (id: string, parentId: string, prefixes: string[]): TreeNode => ({
  workspaceId: id,
  parentId,
  kind: "child",
  writablePrefixes: prefixes,
});

describe("validateTree (G3)", () => {
  it("accepts a valid root-only tree and a valid parent-child tree", () => {
    expect(validateTree([root()])).toEqual([]);
    expect(validateTree([root(["src", "docs"]), child("c1", "root-ws", ["src/core"])])).toEqual([]);
  });

  it("rejects multiple roots", () => {
    const second: TreeNode = { workspaceId: "r2", kind: "root", writablePrefixes: ["docs"] };
    expect(validateTree([root(["src"]), second]).map((e) => e.code)).toContain("multiple-roots");
  });

  it("rejects orphan parent and cycles", () => {
    expect(validateTree([root(["."]), child("c1", "ghost", ["src"])]).map((e) => e.code)).toContain(
      "orphan-parent",
    );
    // cycle: c1 -> c2 -> c1 (no root at all also flags multiple-roots)
    const cyclic: TreeNode[] = [
      { workspaceId: "a", parentId: "b", kind: "child", writablePrefixes: ["x"] },
      { workspaceId: "b", parentId: "a", kind: "child", writablePrefixes: ["y"] },
    ];
    expect(validateTree(cyclic).map((e) => e.code)).toContain("cycle");
  });

  it("rejects child prefix outside parent writable set", () => {
    const errs = validateTree([root(["src"]), child("c1", "root-ws", ["docs"])]);
    expect(errs.map((e) => e.code)).toContain("prefix-not-in-parent");
  });

  it("rejects sibling overlap (segment semantics: src/a vs src/a/b overlap; src/a vs src/b do not)", () => {
    const t1 = [
      root(["src"]),
      child("c1", "root-ws", ["src/a"]),
      child("c2", "root-ws", ["src/a/b"]),
    ];
    expect(validateTree(t1).map((e) => e.code)).toContain("sibling-overlap");
    const t2 = [
      root(["src"]),
      child("c1", "root-ws", ["src/a"]),
      child("c2", "root-ws", ["src/b"]),
    ];
    expect(validateTree(t2)).toEqual([]);
  });

  it("enforces the depth cap", () => {
    const nodes: TreeNode[] = [root(["."])];
    let parent = "root-ws";
    for (let i = 1; i <= DEPTH_CAP + 1; i += 1) {
      const id = `w${i}`;
      nodes.push(child(id, parent, ["."]));
      parent = id;
    }
    expect(validateTree(nodes).map((e) => e.code)).toContain("depth-cap");
  });
});

describe("validateAddChild (G4 structural gate)", () => {
  it("accepts a compliant child, rejects violations and duplicates", () => {
    const base = [root(["src", "docs"])];
    expect(validateAddChild(base, child("c1", "root-ws", ["src/core"]))).toEqual([]);
    expect(validateAddChild(base, child("c1", "root-ws", ["outside"]))[0]?.code).toBe(
      "prefix-not-in-parent",
    );
    expect(
      validateAddChild(
        [...base, child("c1", "root-ws", ["src/core"])],
        child("c1", "root-ws", ["docs"]),
      )[0]?.code,
    ).toBe("bad-node");
  });
});
