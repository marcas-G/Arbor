/**
 * responsibility-tree view. The wire `TreeViewRes.nodes` is a pre-order DFS
 * flat list (derive-side `children` are dropped at the boundary — see
 * projection-runtime `flattenTreeNodes`); tree order is preserved, so nodes
 * render as an ordered node-card list. Node click only forwards the
 * `onOpenWorkspace(workspaceId)` callback (routing lands in a later task).
 */
import type { TreeViewNode, TreeViewRes } from "@arbor/api-contracts";
import { Badge } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, formatCost, Mono } from "./shared.js";

function AttentionBadges({ node }: { readonly node: TreeViewNode }) {
  const { attention, actionRequired } = node.subtreeAttention;
  return (
    <>
      {attention > 0 ? (
        <Badge tone="attention">{`attention ${String(attention)}`}</Badge>
      ) : null}
      {actionRequired > 0 ? (
        <Badge tone="danger">{`actionRequired ${String(actionRequired)}`}</Badge>
      ) : null}
    </>
  );
}

export function ResponsibilityTreeView({
  res,
  onOpenWorkspace,
}: {
  readonly res: TreeViewRes;
  readonly onOpenWorkspace?:
    | ((workspaceId: TreeViewNode["workspaceId"]) => void)
    | undefined;
}) {
  if (res.nodes.length === 0) {
    return <Empty>无工作区</Empty>;
  }
  return (
    <ul className="arbor-tree">
      {res.nodes.map((node) => (
        <li key={node.workspaceId}>
          <button
            type="button"
            className="arbor-tree-node"
            onClick={() => onOpenWorkspace?.(node.workspaceId)}
          >
            <span className="arbor-tree-head">
              <span className="arbor-tree-name">{node.name}</span>
              <EnumBadge label={node.status} />
              <AttentionBadges node={node} />
            </span>
            <span className="arbor-tree-id">
              <Mono>{node.workspaceId}</Mono>
            </span>
            {node.currentWork === undefined ? null : (
              <span className="arbor-tree-objective">
                {node.currentWork.objective}
              </span>
            )}
            {node.usageSummary === undefined ? null : (
              <span className="arbor-tree-usage">
                <Mono>{`tokens ${String(node.usageSummary.tokens)} · cost ${formatCost(node.usageSummary.cost)} · turns ${String(node.usageSummary.turns)}`}</Mono>
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
