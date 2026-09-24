/**
 * P13-004 Problem render coverage (`03` §5 hard requirement 3): the six
 * frozen categories, retryDisposition-driven retry affordances, and the
 * CommandReceiptView TerminalRejected inline error.
 */

import type { Problem } from "@arbor/api-contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandInlineError } from "../src/problems/CommandInlineError.js";
import { ProblemCard } from "../src/problems/ProblemCard.js";
import { D0_PROBLEM_FIXTURES } from "../src/views/fixtures.js";

const problem = (overrides: Partial<Problem>): Problem => ({
  code: "test/problem",
  category: "unavailable",
  message: "test/problem",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: {},
  ...overrides,
});

describe("ProblemCard treatments", () => {
  it("handles every frozen D0 Problem fixture with its explicit treatment", () => {
    const headings = {
      unauthenticated: "未认证",
      forbidden: "权限拒绝",
      "not-found": "对象不存在",
      "invalid-request": "请求错误",
      stale: "数据滞后",
      unavailable: "服务不可用",
    } as const satisfies Record<keyof typeof D0_PROBLEM_FIXTURES, string>;

    for (const [category, fixture] of Object.entries(D0_PROBLEM_FIXTURES)) {
      const rendered = render(<ProblemCard problem={fixture} />);
      expect(
        screen.getByText(headings[category as keyof typeof headings]),
      ).toBeTruthy();
      rendered.unmount();
    }
  });

  it("unauthenticated: global state, token hint, no retry button", () => {
    render(
      <ProblemCard
        problem={problem({
          code: "auth/token-missing",
          category: "unauthenticated",
          retryDisposition: "non-retryable",
        })}
      />,
    );
    expect(screen.getByText("未认证")).toBeTruthy();
    expect(screen.getByText(/提供访问令牌/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("forbidden: denial panel with code and safeDetails.reason", () => {
    render(
      <ProblemCard
        problem={problem({
          code: "authority/denied",
          category: "forbidden",
          safeDetails: { reason: "缺少 RecordDecision 权限" },
        })}
      />,
    );
    expect(screen.getByText("权限拒绝")).toBeTruthy();
    expect(screen.getByText("authority/denied")).toBeTruthy();
    expect(screen.getByText("缺少 RecordDecision 权限")).toBeTruthy();
  });

  it("not-found: empty state with optional back action", () => {
    const onBack = vi.fn();
    const { rerender } = render(
      <ProblemCard
        problem={problem({
          code: "workspace/not-found",
          category: "not-found",
        })}
        onBack={onBack}
      />,
    );
    expect(screen.getByText("对象不存在")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    rerender(
      <ProblemCard
        problem={problem({
          code: "workspace/not-found",
          category: "not-found",
        })}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("invalid-request: error card with expandable code/safeDetails", () => {
    const { container } = render(
      <ProblemCard
        problem={problem({
          code: "transport/invalid-request",
          category: "invalid-request",
          correlationId: "corr-123",
          safeDetails: {
            field: "depth",
            issue: "must be a non-negative integer",
          },
        })}
      />,
    );
    expect(screen.getByText("请求错误")).toBeTruthy();
    expect(screen.getByText("transport/invalid-request")).toBeTruthy();
    const details = container.querySelector("details.arbor-problem-details");
    expect(details).not.toBeNull();
    expect(container.textContent).toContain("correlationId corr-123");
    expect(container.textContent).toContain("must be a non-negative integer");
  });

  it("stale: lag card with retry when onRetry provided", () => {
    const onRetry = vi.fn();
    render(
      <ProblemCard
        problem={problem({
          code: "projection/stale",
          category: "stale",
          retryDisposition: "retryable",
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("数据滞后")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("stale without onRetry renders no retry button", () => {
    render(
      <ProblemCard
        problem={problem({
          code: "projection/stale",
          category: "stale",
          retryDisposition: "retryable",
        })}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("unavailable retryable shows the retry button", () => {
    const onRetry = vi.fn();
    render(
      <ProblemCard
        problem={problem({
          code: "projection/unavailable",
          category: "unavailable",
          retryDisposition: "retryable",
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("服务不可用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("unavailable non-retryable shows no retry button even with onRetry", () => {
    const onRetry = vi.fn();
    render(
      <ProblemCard
        problem={problem({
          code: "projection/unavailable",
          category: "unavailable",
          retryDisposition: "non-retryable",
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("服务不可用")).toBeTruthy();
    expect(screen.getByText("non-retryable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("unknown category receives an explicit Unknown Problem treatment", () => {
    render(<ProblemCard problem={problem({ category: "cosmic" })} />);
    expect(screen.getByText("未知问题")).toBeTruthy();
  });

  it("names all frozen global states in text as well as status styling", () => {
    const categories = [
      ["unauthenticated", "Unauthorized"],
      ["forbidden", "AuthorityDenied"],
      ["invalid-request", "Validation"],
      ["stale", "Stale"],
      ["unavailable", "Network / Unavailable"],
    ] as const;
    for (const [category, label] of categories) {
      const rendered = render(<ProblemCard problem={problem({ category })} />);
      expect(screen.getByText(label)).toBeTruthy();
      rendered.unmount();
    }
  });
});

describe("CommandInlineError (TerminalRejected)", () => {
  it("renders the rejection verbatim plus resubmission hint", () => {
    render(
      <CommandInlineError rejection="authority/denied: 缺少 RecordDecision 权限" />,
    );
    expect(
      screen.getByText("authority/denied: 缺少 RecordDecision 权限"),
    ).toBeTruthy();
    expect(screen.getByText(/重新提交/)).toBeTruthy();
    expect(screen.getByText(/新的 commandId/)).toBeTruthy();
  });

  it("names exact frozen RevisionConflict and AuthorityDenied rejection tags", () => {
    const { rerender } = render(
      <CommandInlineError rejection="RevisionConflict" />,
    );
    expect(screen.getByText("版本冲突")).toBeTruthy();
    rerender(<CommandInlineError rejection="AuthorityDenied" />);
    expect(screen.getByText("权限拒绝")).toBeTruthy();
  });
});
