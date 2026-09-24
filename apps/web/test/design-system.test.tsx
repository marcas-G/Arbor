import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Badge } from "../src/components/Badge.js";
import { Button } from "../src/components/Button.js";
import { Card } from "../src/components/Card.js";
import { Empty } from "../src/components/Empty.js";
import { Field } from "../src/components/Field.js";
import { FreshnessChip } from "../src/components/FreshnessChip.js";
import { KeyValue } from "../src/components/KeyValue.js";
import { MonoText } from "../src/components/MonoText.js";
import { Sheet } from "../src/components/Sheet.js";
import { StatusBadge } from "../src/components/StatusBadge.js";
import { Tabs } from "../src/components/Tabs.js";
import { TimeText } from "../src/components/TimeText.js";
import type { Tone } from "../src/tokens.js";

/** W-01 design-system component contracts (user-event driven). */

const TONES: ReadonlyArray<Tone> = [
  "leaf",
  "attention",
  "danger",
  "muted",
  "branch",
  "sky",
];

describe("W-01 design system", () => {
  it("Button loading 状态禁点且 aria-busy", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole("button", {
      name: "保存",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Button 正常态可点击并透传 type", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="primary" type="submit" onClick={onClick}>
        提交
      </Button>,
    );
    const button = screen.getByRole("button", { name: "提交" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.className).toContain("arbor-button-primary");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Badge 渲染全部六个 tone class", () => {
    const { container } = render(
      <div>
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </div>,
    );
    for (const tone of TONES) {
      expect(container.querySelector(`.arbor-badge-${tone}`)).not.toBeNull();
    }
  });

  it("Tabs 点击切换回调且 aria-selected 跟随 active", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Tabs
        items={[
          { key: "detail", label: "详情" },
          { key: "transcript", label: "转录" },
        ]}
        active="detail"
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("tab", { name: "详情" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "转录" }).getAttribute("aria-selected"),
    ).toBe("false");
    await user.click(screen.getByRole("tab", { name: "转录" }));
    expect(onChange).toHaveBeenCalledWith("transcript");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("Sheet 初始聚焦关闭按钮，并在 Escape 后关闭", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Sheet open title="项目切换" onClose={onClose}>
        内容
      </Sheet>,
    );
    expect(screen.getByRole("dialog", { name: "项目切换" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBe(
      document.activeElement,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Sheet 在 open=false 时不渲染", () => {
    render(
      <Sheet open={false} title="项目切换" onClose={() => {}}>
        内容
      </Sheet>,
    );
    expect(screen.queryByRole("dialog", { name: "项目切换" })).toBeNull();
  });

  it("Sheet closes to the opener", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开项目切换
          </button>
          <Sheet
            open={open}
            title="项目切换"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            内容
          </Sheet>
        </>
      );
    }
    render(<Example />);
    const opener = screen.getByRole("button", { name: "打开项目切换" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toBe(document.activeElement);
  });

  it("FreshnessChip 三态文案与 tone", () => {
    render(
      <>
        <FreshnessChip state="fresh" />
        <FreshnessChip state="stale" />
        <FreshnessChip state="offline" />
      </>,
    );
    const fresh = screen.getByText("实时");
    const stale = screen.getByText("滞后");
    const offline = screen.getByText("离线");
    expect(fresh.className).toContain("arbor-badge-leaf");
    expect(stale.className).toContain("arbor-badge-attention");
    expect(offline.className).toContain("arbor-badge-muted");
  });

  it("StatusBadge 未知词映射 muted 且文本原样", () => {
    render(<StatusBadge label="some-future-label" />);
    const el = screen.getByText("some-future-label");
    expect(el.className).toContain("arbor-badge-muted");
  });

  it("StatusBadge 已知词映射对应 tone", () => {
    render(<StatusBadge label="Completed" />);
    expect(screen.getByText("Completed").className).toContain(
      "arbor-badge-leaf",
    );
  });

  it("Field error 行内呈现并关联 aria", () => {
    render(
      <Field
        control="input"
        label="项目名称"
        value=""
        onChange={() => {}}
        error="必填"
      />,
    );
    const control = screen.getByLabelText("项目名称");
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("必填")).toBeTruthy();
  });

  it("Field 无 error 时不渲染错误行", () => {
    render(
      <Field control="input" label="项目名称" value="x" onChange={() => {}} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("TimeText title 保留原始 ISO 且文本本地化", () => {
    const iso = "2026-09-23T08:00:00Z";
    render(<TimeText iso={iso} />);
    const el = screen.getByTitle(iso);
    expect(el.tagName).toBe("TIME");
    expect(el.getAttribute("datetime")).toBe(iso);
    expect(el.textContent).not.toBe(iso);
  });

  it("TimeText 非法输入回退原样文本", () => {
    render(<TimeText iso="not-a-time" />);
    const el = screen.getByTitle("not-a-time");
    expect(el.textContent).toBe("not-a-time");
  });

  it("Card actions 渲染在标题行", () => {
    render(
      <Card title="责任树" actions={<Button variant="quiet">刷新</Button>}>
        正文
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "责任树" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });

  it("Empty action 按钮触发回调", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Empty action={{ label: "重试", onClick }}>暂无数据</Empty>);
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Empty state is announced to assistive technology", () => {
    render(<Empty>暂无数据</Empty>);
    expect(screen.getByRole("status").textContent).toContain("暂无数据");
  });

  it("KeyValue 渲染 term/value 对", () => {
    render(
      <KeyValue
        pairs={[
          { label: "Workspace", value: "ws_root" },
          { label: "状态", value: "active" },
        ]}
      />,
    );
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("ws_root")).toBeTruthy();
    expect(screen.getByText("状态")).toBeTruthy();
  });

  it("MonoText 渲染 mono 语义类", () => {
    render(<MonoText>ws_root</MonoText>);
    expect(screen.getByText("ws_root").className).toContain("arbor-mono");
  });
});
