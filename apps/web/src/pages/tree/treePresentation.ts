import type { TreeViewNode } from "@arbor/api-contracts";

export type PresentedTree = {
  readonly root: TreeViewNode;
  readonly depths: ReadonlyMap<string, number>;
};

/**
 * Creates presentation-only indentation from the server's explicit parent
 * edges.  It never treats preorder position, a name, or a local selection as
 * hierarchy data; preorder is retained by callers as the stable wire order.
 */
export const presentResponsibilityTree = (
  nodes: ReadonlyArray<TreeViewNode>,
): PresentedTree | null => {
  const byId = new Map(nodes.map((node) => [node.workspaceId as string, node]));
  const roots = nodes.filter((node) => node.parentWorkspaceId === null);
  if (roots.length !== 1 || roots[0] === undefined) {
    return null;
  }

  const depths = new Map<string, number>();
  for (const node of nodes) {
    const nodeId = node.workspaceId as string;
    const visited = new Set<string>();
    let current: TreeViewNode | undefined = node;
    let depth = 0;
    while (current?.parentWorkspaceId !== null) {
      const currentId = current?.workspaceId as string;
      if (visited.has(currentId)) {
        return null;
      }
      visited.add(currentId);
      const parent = byId.get(current.parentWorkspaceId as string);
      if (parent === undefined) {
        return null;
      }
      depth += 1;
      current = parent;
    }
    if (current?.workspaceId !== roots[0].workspaceId) {
      return null;
    }
    depths.set(nodeId, depth);
  }
  return { root: roots[0], depths };
};
