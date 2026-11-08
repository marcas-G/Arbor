/**
 * P13-004 render coverage (`03` §2 hard requirement 2): each of the nine
 * views × {typical, minimal, unknown-enum}. Asserts key fields appear,
 * absent optionals leave blank slots (no zero-values), unknown enum values
 * render verbatim with muted badge tone.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CurrentWorkView } from "../src/views/CurrentWorkView.js";
import { DependencyView } from "../src/views/DependencyView.js";
import {
  currentWorkMinimal,
  currentWorkNull,
  currentWorkTypical,
  currentWorkUnknownEnum,
  dependencyMinimal,
  dependencyTypical,
  dependencyUnknownEnum,
  inboxMinimal,
  inboxTypical,
  inboxUnknownEnum,
  transcriptMinimal,
  transcriptTypical,
  transcriptUnknownEnum,
  usageMinimal,
  usageTypical,
  usageUnknownEnum,
  usageUnknownGroupBy,
  verificationMinimal,
  verificationTypical,
  verificationUnknownEnum,
  workDetailBlocked,
  workDetailMinimal,
  workDetailTerminalProviderFailure,
  workDetailTypical,
  workDetailUnknownEnum,
} from "../src/views/fixtures.js";
import { InboxView } from "../src/views/InboxView.js";
import { TranscriptView } from "../src/views/TranscriptView.js";
import { UsageView } from "../src/views/UsageView.js";
import { VerificationView } from "../src/views/VerificationView.js";
import { WorkDetailView } from "../src/views/WorkDetailView.js";

const expectMutedBadge = (text: string): void => {
  const el = screen.getByText(text);
  expect(el.className).toContain("arbor-badge-muted");
};

describe("current-work", () => {
  it("typical renders objective, status, and a readable running state", () => {
    render(<CurrentWorkView work={currentWorkTypical} />);
    expect(screen.getByText("交付 P13-004 视图渲染层")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("正在运行")).toBeTruthy();
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
    expect(screen.getByText("10 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    expect(screen.getAllByText("必须").length).toBeGreaterThan(0);
    expect(screen.getAllByText("可选").length).toBeGreaterThan(0);
    expect(screen.getAllByText("通过").length).toBe(2);
    expect(screen.getByText("已记录 2 条依据")).toBeTruthy();
    expect(screen.getByText(/已由用户确认于/)).toBeTruthy();
  });

  it("minimal shows empty criteria and evidence", () => {
    render(<VerificationView view={verificationMinimal} />);
    expect(screen.getByText("尚无结论")).toBeTruthy();
    expect(screen.getByText("尚未设置验证条件")).toBeTruthy();
    expect(screen.getByText("尚未记录依据")).toBeTruthy();
  });

  it("unknown verdict renders verbatim with muted badge", () => {
    render(<VerificationView view={verificationUnknownEnum} />);
    expect(screen.getByText("Banana")).toBeTruthy();
    expectMutedBadge("Banana");
  });

  it("does not present unpersisted criterion verdicts as an aggregate unknown result", () => {
    render(<VerificationView view={verificationTypical} />);
    expect(screen.getAllByText("未单独记录").length).toBeGreaterThan(0);
    expect(screen.queryByText("无法判断")).toBeNull();
  });

  it("mobile presents each server criterion as a readable card", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    render(<VerificationView view={verificationTypical} />);
    expect(screen.getByRole("list", { name: "验证条件" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("10 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });
});

describe("work-detail", () => {
  it("typical renders objective, canonical Completed state and accepted result", () => {
    render(<WorkDetailView view={workDetailTypical} />);
    expect(screen.getByText("让完成后的工作仍可查看")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByText(/当前版本/)).toBeNull();
    expect(screen.getByText("通过")).toBeTruthy();
    expect(screen.getByText("用户确认")).toBeTruthy();
  });

  it("accepted but Open stays distinct from Completed", () => {
    render(
      <WorkDetailView view={{ ...workDetailTypical, lifecycle: "Open" }} />,
    );
    expect(screen.getByText("已验收、待完成")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
  });

  it("Cancelled stays canonical and labels any acceptance as history", () => {
    render(
      <WorkDetailView
        view={{ ...workDetailTypical, lifecycle: "Cancelled" }}
      />,
    );
    expect(screen.getByText("已取消")).toBeTruthy();
    expect(screen.getByText("历史验收")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
  });

  it("minimal shows missing acceptance, unknown lifecycle is verbatim", () => {
    const { rerender } = render(<WorkDetailView view={workDetailMinimal} />);
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("这项工作尚未验收")).toBeTruthy();
    rerender(<WorkDetailView view={workDetailUnknownEnum} />);
    expect(screen.getByText("Paused")).toBeTruthy();
    expectMutedBadge("Paused");
  });

  it("renders a safe blocked explanation without presenting it as Complete or Accepted", () => {
    render(<WorkDetailView view={workDetailBlocked} />);
    expect(screen.getByRole("status", { name: "工作受阻" })).toBeTruthy();
    expect(screen.getByText("本轮执行已阻断")).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toContain(
      "HandlerRejected",
    );
    expect(
      screen.getByText("检查所需权限后，提供新指导以继续本工作。"),
    ).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
    expect(screen.queryByText("验收结果")).toBeNull();
  });

  it("renders terminal Provider failure code, exact occurrence time and Work revision without retry", () => {
    render(<WorkDetailView view={workDetailTerminalProviderFailure} />);
    expect(screen.getByRole("status", { name: "模型提供方失败" })).toBeTruthy();
    expect(screen.getByText("RequestRejected")).toBeTruthy();
    expect(screen.getAllByText("修订版本 2").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /重新验证|Retry Verification/iu }),
    ).toBeNull();
  });
});

describe("dependency-view", () => {
  it("typical renders user-facing dependency progress with no internal IDs", () => {
    render(<DependencyView res={dependencyTypical} />);
    expect(screen.getByText("任意工作")).toBeTruthy();
    expect(screen.getByText("已满足")).toBeTruthy();
    expect(screen.getByText("等待中")).toBeTruthy();
    expect(screen.getByText("已收到结果")).toBeTruthy();
    expect(screen.queryByText(/^(dep|wrk|del)_/)).toBeNull();
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

  it("distinguishes withdrawn and unfulfillable dependencies from waiting", () => {
    const original = dependencyTypical.rows[0];
    if (original === undefined) throw new Error("missing dependency fixture");
    render(
      <DependencyView
        res={{
          rows: [
            {
              ...original,
              dependencyId: "dep_withdrawn" as never,
              state: "Withdrawn",
            },
            {
              ...original,
              dependencyId: "dep_unfulfillable" as never,
              state: "Unfulfillable",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("已撤回")).toBeTruthy();
    expect(screen.getByText("无法满足").className).toContain(
      "arbor-badge-danger",
    );
    expect(screen.queryByText("等待中")).toBeNull();
  });
});

describe("transcript", () => {
  it("typical renders entries and forwards onLoadMore(cursor)", () => {
    const onLoadMore = vi.fn();
    render(<TranscriptView res={transcriptTypical} onLoadMore={onLoadMore} />);
    expect(screen.getByText("turn#12 请求评审")).toBeTruthy();
    expect(screen.getByText("人工调整")).toBeTruthy();
    expect(screen.getByText("协作结果已确认")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多记录" }));
    expect(onLoadMore).toHaveBeenCalledWith("cursor-018f6a2e-older");
  });

  it("does not show an inert pagination button without a load handler", () => {
    render(<TranscriptView res={transcriptTypical} />);
    expect(screen.queryByRole("button", { name: "加载更多记录" })).toBeNull();
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

  it("hides internal ModelOutput entries while keeping conversation and other events", () => {
    render(
      <TranscriptView
        res={{
          entries: [
            {
              kind: "HumanConversationTurn",
              messageId: "msg_1",
              body: "用户消息",
              occurredAt: "2026-09-26T06:00:00.000Z",
            },
            {
              kind: "AssistantConversationTurn",
              executionId: "exe_1",
              body: "正式助手回复",
              occurredAt: "2026-09-26T06:01:00.000Z",
            },
            {
              kind: "ModelOutput",
              summaryRef: "session-entry:ses_1:0",
              at: "2026-09-26T06:00:30.000Z",
            },
            {
              kind: "HumanInput",
              summaryRef: "其他会话事件",
              at: "2026-09-26T05:59:00.000Z",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("用户消息")).toBeTruthy();
    expect(screen.getByText("正式助手回复")).toBeTruthy();
    expect(screen.getByText("人工调整")).toBeTruthy();
    expect(screen.getByText("其他会话事件")).toBeTruthy();
    expect(screen.queryByText("ModelOutput")).toBeNull();
    expect(screen.queryByText("session-entry:ses_1:0")).toBeNull();
    expect(screen.getByText("其他会话事件")).toBeTruthy();
  });

  it("hides the internal session-entry fallback reference", () => {
    render(
      <TranscriptView
        res={{
          entries: [
            {
              kind: "Message",
              summaryRef: "session-entry:ses_internal:12",
              at: "2026-09-26T06:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("历史会话记录")).toBeTruthy();
    expect(screen.queryByText("session-entry:ses_internal:12")).toBeNull();
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
    expect(screen.getByText("暂不可用")).toBeTruthy();
    expect(screen.queryByText(/合计/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "含下级责任" }));
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
    expect(screen.getByText("消息")).toBeTruthy();
    expect(screen.getByText("待决策")).toBeTruthy();
    expect(screen.getByText("来自守护进程的阻塞通知")).toBeTruthy();
    expect(screen.queryByText("wm 41")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("minimal (no rows) shows the empty state", () => {
    render(<InboxView res={inboxMinimal} />);
    expect(screen.getByText("暂无待处理消息")).toBeTruthy();
  });

  it("unknown kind renders verbatim with muted badge", () => {
    render(<InboxView res={inboxUnknownEnum} />);
    expect(screen.getByText("MysteryKind")).toBeTruthy();
    expectMutedBadge("MysteryKind");
  });
});
