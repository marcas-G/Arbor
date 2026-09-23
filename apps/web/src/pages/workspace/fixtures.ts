/**
 * W-05 test fixtures — ws_1 scoped shapes missing from views/fixtures.ts
 * (tree node carrying this workspace's subtreeAttention, explicit-null
 * currentWork detail, second transcript page, failure Problem). The wire
 * carries EXPLICIT nulls for absent optionals — hence the one structural
 * cast (same ruling as `treeExplicitNulls`).
 */
import type {
  Problem,
  TranscriptRes,
  TreeViewRes,
  WorkspaceDetailRes,
} from "@arbor/api-contracts";
import { detailTypical } from "../../views/fixtures.js";

const id = (value: string): never => value as never;

export const treeWsFixture: TreeViewRes = {
  nodes: [
    {
      workspaceId: id("ws_root"),
      name: "平台根工作区",
      status: "idle",
      subtreeAttention: { attention: 0, actionRequired: 0 },
    },
    {
      workspaceId: id("ws_1"),
      name: "渲染工作区",
      status: "executing",
      subtreeAttention: { attention: 2, actionRequired: 1 },
    },
  ],
};

export const detailNoCurrentWork = {
  ...detailTypical,
  currentWork: null,
} as unknown as WorkspaceDetailRes;

export const transcriptPage2: TranscriptRes = {
  entries: [
    {
      kind: "Message",
      summaryRef: "turn#9 早期记录",
      at: "2026-09-23T08:40:00.000Z",
    },
    {
      kind: "HumanInput",
      summaryRef: "turn#8 更早的人工输入",
      at: "2026-09-23T08:30:00.000Z",
    },
  ],
};

export const unavailableProblem: Problem = {
  code: "view/transcript-unavailable",
  category: "unavailable",
  message: "transcript view failed",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {},
};
