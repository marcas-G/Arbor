/**
 * P13-004 render coverage (`03` §2 hard requirement 2): each of the nine
 * views × {typical, minimal, unknown-enum}. Asserts key fields appear,
 * absent optionals leave blank slots (no zero-values), unknown enum values
 * render verbatim with muted badge tone.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttentionView } from "../src/views/AttentionView.js";
import { CurrentWorkView } from "../src/views/CurrentWorkView.js";
import { DependencyView } from "../src/views/DependencyView.js";
import {
  attentionMinimal,
  attentionTypical,
  attentionUnknownEnum,
  currentWorkMinimal,
  currentWorkNull,
  currentWorkTypical,
  currentWorkUnknownEnum,
  dependencyMinimal,
  dependencyTypical,
  dependencyUnknownEnum,
  detailMinimal,
  detailTypical,
  detailUnknownEnum,
  inboxMinimal,
  inboxTypical,
  inboxUnknownEnum,
  transcriptMinimal,
  transcriptTypical,
  transcriptUnknownEnum,
  treeExplicitNulls,
  treeMinimal,
  treeTypical,
  treeUnknownEnum,
  usageMinimal,
  usageTypical,
  usageUnknownEnum,
  usageUnknownGroupBy,
  verificationMinimal,
  verificationTypical,
  verificationUnknownEnum,
} from "../src/views/fixtures.js";
import { InboxView } from "../src/views/InboxView.js";
import { ResponsibilityTreeView } from "../src/views/ResponsibilityTreeView.js";
import { TranscriptView } from "../src/views/TranscriptView.js";
import { UsageView } from "../src/views/UsageView.js";
import { VerificationView } from "../src/views/VerificationView.js";
import { WorkspaceDetailView } from "../src/views/WorkspaceDetailView.js";

const expectMutedBadge = (text: string): void => {
  const el = screen.getByText(text);
  expect(el.className).toContain("arbor-badge-muted");
};

describe("responsibility-tree", () => {
  it("typical renders names, badges, attention counts, objective, usage", () => {
    render(<ResponsibilityTreeView res={treeTypical} />);
    expect(screen.getByText("平台根工作区")).toBeTruthy();
    expect(screen.getByText("executing")).toBeTruthy();
    expect(screen.getByText("attention 2")).toBeTruthy();
    expect(screen.getByText("actionRequired 1")).toBeTruthy();
    expect(screen.getByText("维护 P13 视图渲染合同")).toBeTruthy();
    expect(
      screen.getByText("tokens 1200 · cost 0.42 USD · turns 7"),
    ).toBeTruthy();
    expect(
      screen.getByText("tokens 300 · cost unknown · turns 2"),
    ).toBeTruthy();
  });

  it("minimal node leaves blank slots (no zero usage, no attention badges)", () => {
    render(<ResponsibilityTreeView res={treeMinimal} />);
    expect(screen.getByText("仅必要字段")).toBeTruthy();
    expect(screen.queryByText(/tokens \d+/)).toBeNull();
    expect(screen.queryByText(/^attention \d+$/)).toBeNull();
    expect(screen.queryByText(/^actionRequired \d+$/)).toBeNull();
  });

  it("unknown status renders verbatim with muted badge", () => {
    render(<ResponsibilityTreeView res={treeUnknownEnum} />);
    expect(screen.getByText("weird-state")).toBeTruthy();
    expectMutedBadge("weird-state");
  });

  it("node click forwards onOpenWorkspace(workspaceId)", () => {
    const onOpenWorkspace = vi.fn();
    render(
      <ResponsibilityTreeView
        res={treeTypical}
        onOpenWorkspace={onOpenWorkspace}
      />,
    );
    fireEvent.click(screen.getByText("平台根工作区"));
    expect(onOpenWorkspace).toHaveBeenCalledWith(
      "ws_018f6a2e-0000-7000-8000-000000000001",
    );
  });
});

describe("attention", () => {
  it("typical groups rows with ActionRequired first and workspace links", () => {
    const { container } = render(<AttentionView res={attentionTypical} />);
    const groups = container.querySelectorAll(".arbor-attention-group");
    expect(groups.length).toBe(2);
    expect(groups[0]?.textContent).toContain("ActionRequired");
    expect(groups[0]?.textContent).toContain("Deadlock");
    expect(groups[1]?.textContent).toContain("Attention");
    expect(screen.getByText("wait-cycles#1")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "ws_018f6a2e-0000-7000-8000-000000000003",
      }),
    ).toBeTruthy();
  });

  it("minimal (no rows) shows the empty state", () => {
    render(<AttentionView res={attentionMinimal} />);
    expect(screen.getByText("无注意力事实")).toBeTruthy();
  });

  it("unknown source and severity render verbatim with muted badge", () => {
    render(<AttentionView res={attentionUnknownEnum} />);
    expect(screen.getByText("MysterySource")).toBeTruthy();
    expectMutedBadge("MysterySource");
    expect(screen.getByText("WeirdSeverity")).toBeTruthy();
    expectMutedBadge("WeirdSeverity");
  });

  it("row link forwards onOpenWorkspace(targetWorkspaceId)", () => {
    const onOpenWorkspace = vi.fn();
    render(
      <AttentionView
        res={attentionTypical}
        onOpenWorkspace={onOpenWorkspace}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "ws_018f6a2e-0000-7000-8000-000000000003",
      }),
    );
    expect(onOpenWorkspace).toHaveBeenCalledWith(
      "ws_018f6a2e-0000-7000-8000-000000000003",
    );
  });
});

describe("workspace-detail", () => {
  it("typical renders the full panoramic card group", () => {
    render(<WorkspaceDetailView res={detailTypical} />);
    expect(
      screen.getByText("承载 Arbor web 渲染合同的实施与演进"),
    ).toBeTruthy();
    expect(screen.getByText("FileTree /srv/arbor/web")).toBeTruthy();
    expect(
      screen.getByText("GitWorktree /srv/arbor/worktrees/p13 @p13-views"),
    ).toBeTruthy();
    expect(screen.getByText("DatabaseNamespace arbor_main")).toBeTruthy();
    expect(screen.getByText("交付 P13-004 视图渲染层")).toBeTruthy();
    expect(screen.getByText("命令面板接线")).toBeTruthy();
    expect(
      screen.getByText(
        "WorkspaceBound ws_018f6a2e-0000-7000-8000-000000000002",
      ),
    ).toBeTruthy();
    expect(screen.getByText("来自守护进程的阻塞通知")).toBeTruthy();
    expect(screen.getByText("wm 41")).toBeTruthy();
    expect(screen.getByText("9 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    expect(screen.getByText("human:root")).toBeTruthy();
    expect(screen.getByText("WorkspaceCreated")).toBeTruthy();
    expect(screen.getByText("CurrentWorkChanged")).toBeTruthy();
  });

  it("minimal omits optional cards and shows empty-collection states", () => {
    render(<WorkspaceDetailView res={detailMinimal} />);
    expect(screen.getByText("最小职责")).toBeTruthy();
    expect(screen.queryByText("当前工作")).toBeNull();
    expect(screen.queryByText("执行摘要")).toBeNull();
    expect(screen.queryByText("Verification")).toBeNull();
    expect(screen.getByText("无资源地址")).toBeTruthy();
    expect(screen.getByText("无待办工作")).toBeTruthy();
    expect(screen.getByText("无依赖")).toBeTruthy();
    expect(screen.getByText("无未消费条目")).toBeTruthy();
    expect(screen.getByText("无审计事件")).toBeTruthy();
  });

  it("unknown enums render verbatim with muted badges", () => {
    render(<WorkspaceDetailView res={detailUnknownEnum} />);
    expect(screen.getByText("weird-state")).toBeTruthy();
    expectMutedBadge("weird-state");
    expect(screen.getByText("Teleported")).toBeTruthy();
    expectMutedBadge("Teleported");
    expect(screen.getByText("CosmicEventHappened")).toBeTruthy();
  });
});

describe("current-work", () => {
  it("typical renders objective, status, execution", () => {
    render(<CurrentWorkView work={currentWorkTypical} />);
    expect(screen.getByText("交付 P13-004 视图渲染层")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(
      screen.getByText("exe_018f6a2e-0000-7000-8000-0000000000e1"),
    ).toBeTruthy();
  });

  it("minimal leaves workId/activeExecution as blank slots", () => {
    render(<CurrentWorkView work={currentWorkMinimal} />);
    expect(screen.getByText("仅必要字段的当前工作")).toBeTruthy();
    expect(screen.queryByText(/exe_/)).toBeNull();
    expect(screen.queryByText(/wrk_/)).toBeNull();
  });

  it("null renders the empty state with no action", () => {
    render(<CurrentWorkView work={currentWorkNull} />);
    expect(screen.getByText("无当前工作")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("unknown status renders verbatim with muted badge", () => {
    render(<CurrentWorkView work={currentWorkUnknownEnum} />);
    expect(screen.getByText("weird-state")).toBeTruthy();
    expectMutedBadge("weird-state");
  });
});

describe("verification", () => {
  it("typical renders criteria table, evidence, acceptance", () => {
    render(<VerificationView view={verificationTypical} />);
    expect(screen.getByText("crit-render")).toBeTruthy();
    expect(screen.getByText("9 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    expect(screen.getAllByText("required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("optional").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pass").length).toBe(2);
    expect(
      screen.getByText("evd_018f6a2e-0000-7000-8000-0000000000f1"),
    ).toBeTruthy();
    expect(screen.getByText("human:root")).toBeTruthy();
  });

  it("minimal shows empty criteria and evidence", () => {
    render(<VerificationView view={verificationMinimal} />);
    expect(screen.getByText("无判定结果")).toBeTruthy();
    expect(screen.getByText("无证据")).toBeTruthy();
  });

  it("unknown verdict renders verbatim with muted badge", () => {
    render(<VerificationView view={verificationUnknownEnum} />);
    expect(screen.getByText("Banana")).toBeTruthy();
    expectMutedBadge("Banana");
  });
});

describe("dependency-view", () => {
  it("typical renders binding/state/satisfiedBy with no row actions", () => {
    render(<DependencyView res={dependencyTypical} />);
    expect(screen.getByText("AnyProducer")).toBeTruthy();
    expect(screen.getByText("Satisfied")).toBeTruthy();
    expect(screen.getByText("Unsatisfied")).toBeTruthy();
    expect(
      screen.getByText("del_018f6a2e-0000-7000-8000-0000000000b1"),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("minimal (no rows) shows the empty state", () => {
    render(<DependencyView res={dependencyMinimal} />);
    expect(screen.getByText("无依赖")).toBeTruthy();
  });

  it("unknown state renders verbatim with muted badge", () => {
    render(<DependencyView res={dependencyUnknownEnum} />);
    expect(screen.getByText("Teleported")).toBeTruthy();
    expectMutedBadge("Teleported");
  });
});

describe("transcript", () => {
  it("typical renders entries and forwards onLoadMore(cursor)", () => {
    const onLoadMore = vi.fn();
    render(<TranscriptView res={transcriptTypical} onLoadMore={onLoadMore} />);
    expect(screen.getByText("turn#12 请求评审")).toBeTruthy();
    expect(screen.getByText("HumanInput")).toBeTruthy();
    expect(screen.getByText("SpecialistSettled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "更早" }));
    expect(onLoadMore).toHaveBeenCalledWith("cursor-018f6a2e-older");
  });

  it("minimal shows the empty state and no older button", () => {
    render(<TranscriptView res={transcriptMinimal} />);
    expect(screen.getByText("无会话记录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更早" })).toBeNull();
  });

  it("unknown kind renders verbatim with muted badge", () => {
    render(<TranscriptView res={transcriptUnknownEnum} />);
    expect(screen.getByText("CosmicRay")).toBeTruthy();
    expectMutedBadge("CosmicRay");
  });
});

describe("usage", () => {
  it("typical renders rows verbatim and forwards groupBy change", () => {
    const onGroupByChange = vi.fn();
    render(
      <UsageView
        res={usageTypical}
        groupBy="workspace"
        onGroupByChange={onGroupByChange}
      />,
    );
    expect(screen.getByText("0.42 USD")).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();
    expect(screen.queryByText(/合计/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "subtree" }));
    expect(onGroupByChange).toHaveBeenCalledWith("subtree");
  });

  it("minimal (no rows) shows the empty state", () => {
    render(<UsageView res={usageMinimal} groupBy="workspace" />);
    expect(screen.getByText("无用量数据")).toBeTruthy();
  });

  it("unknown groupBy value renders verbatim without a matching option", () => {
    const { container } = render(
      <UsageView res={usageUnknownEnum} groupBy={usageUnknownGroupBy} />,
    );
    expect(screen.getByText("galaxy")).toBeTruthy();
    expect(container.querySelector("button.arbor-button-primary")).toBeNull();
  });
});

describe("inbox-view", () => {
  it("typical renders kind/summary/watermark with no consume action", () => {
    render(<InboxView res={inboxTypical} />);
    expect(screen.getByText("Message")).toBeTruthy();
    expect(screen.getByText("Governance")).toBeTruthy();
    expect(screen.getByText("来自守护进程的阻塞通知")).toBeTruthy();
    expect(screen.getByText("wm 41")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("minimal (no rows) shows the empty state", () => {
    render(<InboxView res={inboxMinimal} />);
    expect(screen.getByText("无未消费条目")).toBeTruthy();
  });

  it("unknown kind renders verbatim with muted badge", () => {
    render(<InboxView res={inboxUnknownEnum} />);
    expect(screen.getByText("MysteryKind")).toBeTruthy();
    expectMutedBadge("MysteryKind");
  });
});
