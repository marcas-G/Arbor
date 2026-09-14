import { Schema } from "effect";
import { isPathWithinPrefix, normalizeProjectPath, type ProjectPath } from "./project-path.js";

/** P2 (D-041 G2/G3): Engineering Tree — structural truth over workspaces.
 * Stored as workspace-store/engineering-tree.json under its own CAS ref. */

export const TreeNodeSchema = Schema.Struct({
  workspaceId: Schema.String,
  parentId: Schema.optional(Schema.String), // absent = root
  kind: Schema.Literals(["root", "child"]),
  writablePrefixes: Schema.Array(Schema.String).pipe(
    Schema.refine((arr): arr is Array<string> => arr.length >= 1, {
      identifier: "nonEmptyWritablePrefixes",
    }),
  ),
});
export interface TreeNode extends Schema.Schema.Type<typeof TreeNodeSchema> {}

export const EngineeringTreeSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  nodes: Schema.Array(TreeNodeSchema),
});
export interface EngineeringTree extends Schema.Schema.Type<typeof EngineeringTreeSchema> {}

export const DEPTH_CAP = 3;

const canon = (s: string): ProjectPath | undefined => {
  const n = normalizeProjectPath(s);
  return n.kind === "ok" ? { value: n.value } : undefined;
};

const covers = (ancestor: string, p: string): boolean => {
  const a = canon(ancestor);
  const c = canon(p);
  return a !== undefined && c !== undefined && isPathWithinPrefix(a, c);
};

const overlaps = (a: string, b: string): boolean => covers(a, b) || covers(b, a);

export interface TreeValidationError {
  readonly code:
    | "multiple-roots"
    | "orphan-parent"
    | "cycle"
    | "depth-cap"
    | "prefix-not-in-parent"
    | "sibling-overlap"
    | "bad-node";
  readonly detail: string;
}

/** G3 invariants as a pure function. Returns [] when the tree is valid. */
export function validateTree(nodes: ReadonlyArray<TreeNode>): TreeValidationError[] {
  const errors: TreeValidationError[] = [];
  const byId = new Map(nodes.map((n) => [n.workspaceId, n]));

  const roots = nodes.filter((n) => n.parentId === undefined);
  if (roots.length !== 1) {
    errors.push({
      code: "multiple-roots",
      detail: `expected exactly 1 root, found ${roots.length}`,
    });
  }
  if (roots.length > 0 && roots[0]?.kind !== "root") {
    errors.push({ code: "bad-node", detail: "root node must have kind 'root'" });
  }

  // parent existence + kind sanity + depth via walk-to-root with cycle guard
  const depthOf = (node: TreeNode, seen = new Set<string>()): number => {
    if (seen.has(node.workspaceId)) {
      errors.push({ code: "cycle", detail: `cycle through ${node.workspaceId}` });
      return Number.POSITIVE_INFINITY;
    }
    seen.add(node.workspaceId);
    if (node.parentId === undefined) {
      return 1;
    }
    const parent = byId.get(node.parentId);
    if (parent === undefined) {
      errors.push({
        code: "orphan-parent",
        detail: `${node.workspaceId} references missing parent ${node.parentId}`,
      });
      return Number.POSITIVE_INFINITY;
    }
    return 1 + depthOf(parent, seen);
  };
  for (const n of nodes) {
    if (n.kind === "child" && n.parentId === undefined) {
      errors.push({ code: "bad-node", detail: `${n.workspaceId}: child without parent` });
    }
    const d = depthOf(n);
    if (Number.isFinite(d) && d > DEPTH_CAP) {
      errors.push({
        code: "depth-cap",
        detail: `${n.workspaceId} at depth ${d} > cap ${DEPTH_CAP}`,
      });
    }
  }

  // resource constraints: child ⊆ parent, siblings disjoint
  for (const n of nodes) {
    const parent = n.parentId !== undefined ? byId.get(n.parentId) : undefined;
    if (parent === undefined) {
      continue;
    }
    for (const p of n.writablePrefixes) {
      if (!parent.writablePrefixes.some((pp) => covers(pp, p))) {
        errors.push({
          code: "prefix-not-in-parent",
          detail: `${n.workspaceId}: prefix '${p}' is not within any parent writable prefix`,
        });
      }
    }
  }
  const childrenOf = (parentId: string) => nodes.filter((n) => n.parentId === parentId);
  for (const parent of nodes) {
    const siblings = childrenOf(parent.workspaceId);
    for (let i = 0; i < siblings.length; i += 1) {
      for (let j = i + 1; j < siblings.length; j += 1) {
        const a = siblings[i] as TreeNode;
        const b = siblings[j] as TreeNode;
        if (a.writablePrefixes.some((pa) => b.writablePrefixes.some((pb) => overlaps(pa, pb)))) {
          errors.push({
            code: "sibling-overlap",
            detail: `${a.workspaceId} and ${b.workspaceId} have overlapping writable prefixes`,
          });
        }
      }
    }
  }
  return errors;
}

/** Validate the tree that would result from adding a candidate child. */
export function validateAddChild(
  nodes: ReadonlyArray<TreeNode>,
  candidate: TreeNode,
): TreeValidationError[] {
  if (nodes.some((n) => n.workspaceId === candidate.workspaceId)) {
    return [{ code: "bad-node", detail: `duplicate workspaceId ${candidate.workspaceId}` }];
  }
  return validateTree([...nodes, candidate]);
}
