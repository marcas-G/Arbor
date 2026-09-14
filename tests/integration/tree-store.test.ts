import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commitTree,
  readTree,
  TREE_REF,
  treeRefCommit,
} from "../../src/infrastructure/tree-store.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-tree-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const makeStore = (dir: string) => {
  execSync("git init -q && echo init > .init", { cwd: dir });
  execSync("git add -A && git -c user.name=t -c user.email=t@t commit -qm e0", { cwd: dir });
  return dir;
};

describe("tree store (G2)", () => {
  it("round-trips nodes through file + CAS ref", async () => {
    const store = makeStore(tmp());
    const nodes = [
      { workspaceId: "root-ws", kind: "root" as const, writablePrefixes: ["src"] },
      {
        workspaceId: "c1",
        parentId: "root-ws",
        kind: "child" as const,
        writablePrefixes: ["src/core"],
      },
    ];
    const first = await commitTree(store, nodes, undefined);
    expect(first.ok).toBe(true);
    expect(await treeRefCommit(store)).toBe(first.newCommit);
    expect((await readTree(store)).nodes).toEqual(nodes);

    // CAS success with the right prior (content must differ for a commit)
    const grown = [
      ...nodes,
      {
        workspaceId: "c2",
        parentId: "root-ws",
        kind: "child" as const,
        writablePrefixes: ["docs"],
      },
    ];
    const second = await commitTree(store, grown, first.newCommit);
    expect(second.ok).toBe(true);
    // CAS failure with a stale prior
    const stale = await commitTree(
      store,
      [
        ...grown,
        {
          workspaceId: "c3",
          kind: "child" as const,
          parentId: "root-ws",
          writablePrefixes: ["misc"],
        },
      ],
      first.newCommit,
    );
    expect(stale.ok).toBe(false);
    // ref still points at the second commit
    expect(await treeRefCommit(store)).toBe(second.newCommit);
    expect(execSync(`git -C ${store} rev-parse ${TREE_REF}`, { encoding: "utf8" }).trim()).toBe(
      second.newCommit,
    );
  });

  it("readTree on a store without the file returns empty tree", async () => {
    const store = makeStore(tmp());
    expect(await readTree(store)).toEqual({ schemaVersion: 1, nodes: [] });
    expect(await treeRefCommit(store)).toBeUndefined();
  });
});
