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
} from "../src/views/fixtures.js";
import { InboxView } from "../src/views/InboxView.js";
import { TranscriptView } from "../src/views/TranscriptView.js";
import { UsageView } from "../src/views/UsageView.js";
import { VerificationView } from "../src/views/VerificationView.js";

const expectMutedBadge = (text: string): void => {
  const el = screen.getByText(text);
  expect(el.className).toContain("arbor-badge-muted");
};

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

  it("mobile presents each server criterion as a readable card", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    render(<VerificationView view={verificationTypical} />);
    expect(screen.getByRole("list", { name: "验证条件" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("9 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
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
