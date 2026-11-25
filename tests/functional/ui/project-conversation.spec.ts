import { expect, test } from "@playwright/test";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";

let fixture: ProductionFixture;

test.beforeAll(async () => {
  fixture = await startProductionFixture({
    reply: (call) => {
      const messages = JSON.stringify(call.messages);
      const marker = /UI-FUNCTIONAL-[A-Z0-9-]+/u.exec(messages)?.[0];
      return marker === undefined ? "UI_FUNCTIONAL_ACK" : `已收到 ${marker}`;
    },
  });
});

test.afterAll(async () => {
  await fixture.stop();
});

test("a user creates a project, chats, and sees the answer after restart", async ({
  page,
}) => {
  const marker = `UI-FUNCTIONAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  await page.goto(fixture.baseUrl);

  await expect(
    page.getByRole("heading", { name: "把复杂目标，变成持续推进的工作" }),
  ).toBeVisible();
  const conversationOnly = page.getByRole("radio", { name: "仅对话" });
  await expect(conversationOnly).toBeVisible();
  await expect(conversationOnly).not.toBeChecked();
  await expect(
    page.getByText(/不能使用文件工具，也不能完成需要文件证据的\s*Work/u),
  ).toBeVisible();
  await page.getByLabel("项目名称").fill("功能测试项目");
  await conversationOnly.click();
  await page.getByRole("button", { name: /^(开始使用|创建项目)$/u }).click();

  await expect(page).toHaveURL(/\/p\/prj_[A-Za-z0-9-]+$/u);
  await expect(page.getByRole("heading", { name: "对话" })).toBeVisible();
  await expect(page.getByLabel("消息")).toBeEditable();

  const buttonStyle = await page
    .getByRole("button", { name: "发送", exact: true })
    .evaluate((element) => {
      const view = element.ownerDocument.defaultView;
      const style = view.getComputedStyle(element);
      const tokens = view.getComputedStyle(
        element.ownerDocument.documentElement,
      );
      return {
        font: style.fontSize,
        expectedFont: tokens.getPropertyValue("--arbor-text-small").trim(),
      };
    });
  expect(buttonStyle.font).toBe(buttonStyle.expectedFont);

  // Verify rendered utilities at real breakpoints; jsdom cannot measure layout.
  const layout = page.getByTestId("workbench-layout");
  const separator = page.getByRole("separator", {
    name: "调整工作分工与对话比例",
  });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByLabel("消息")).toBeVisible();
    const grid = await layout.evaluate(
      (element) =>
        element.ownerDocument.defaultView?.getComputedStyle(element)
          .gridTemplateColumns,
    );
    expect(grid.split(" ")).toHaveLength(width > 1024 ? 3 : 1);
    await expect(
      page.getByRole("navigation", { name: "主导航", exact: true }),
    ).toBeVisible({ visible: width >= 768 });
    await expect(
      page.getByRole("navigation", { name: "移动导航", exact: true }),
    ).toBeVisible({ visible: width < 768 });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    if (width < 768) {
      const tabs = page.getByRole("group", { name: "工作台面板" });
      await tabs.getByRole("button", { name: "工作分工", exact: true }).click();
      await expect(page.getByLabel("消息")).toBeHidden();
      await expect(
        page.getByRole("heading", { name: "工作分工", exact: true }),
      ).toBeVisible();
      await tabs.getByRole("button", { name: "对话", exact: true }).click();
      await expect(page.getByLabel("消息")).toBeVisible();
    }
    const opener = page.getByRole("button", {
      name: "打开项目中心",
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "项目中心", exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeFocused();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
    expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(
      width + 1,
    );
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((element) =>
          element.contains(element.ownerDocument.activeElement),
        ),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(separator).toBeVisible();
  const beforeResize = await layout.evaluate(
    (element) =>
      element.ownerDocument.defaultView?.getComputedStyle(element)
        .gridTemplateColumns,
  );
  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      layout.evaluate(
        (element) =>
          element.ownerDocument.defaultView?.getComputedStyle(element)
            .gridTemplateColumns,
      ),
    )
    .not.toBe(beforeResize);
  const beforeSwap = await layout
    .locator(":scope > section")
    .first()
    .getAttribute("aria-labelledby");
  await page
    .getByRole("button", { name: "交换分工与对话位置", exact: true })
    .click();
  await expect(layout.locator(":scope > section").first()).not.toHaveAttribute(
    "aria-labelledby",
    beforeSwap ?? "",
  );

  await page.getByLabel("消息").fill(`你好 ${marker}`);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(`你好 ${marker}`, { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-phase="authoritative"]')
      .getByText(`已收到 ${marker}`, { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });

  expect(
    fixture.providerCalls.some((call) =>
      JSON.stringify(call.messages).includes(marker),
    ),
  ).toBe(true);
  const viewport = page.locator('[data-virtuoso-scroller="true"]');
  expect((await viewport.boundingBox())?.height).toBeGreaterThan(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .locator('[data-phase="authoritative"]')
      .getByText(`已收到 ${marker}`, { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("workbench-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: test.info().outputPath("workbench-desktop.png"),
    fullPage: true,
  });
  const callsBeforeRestart = fixture.providerCalls.length;

  await fixture.restart();
  await page.reload();
  await expect(page.getByText(`你好 ${marker}`, { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-phase="authoritative"]')
      .getByText(`已收到 ${marker}`, { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(fixture.providerCalls).toHaveLength(callsBeforeRestart);
  const projectUrl = page.url();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [path, heading] of [
      ["tree", "项目结构"],
      ["queue", "待处理"],
      ["attention", "关注事项"],
      ["usage", "用量"],
      ["settings", "设置"],
    ] as const) {
      await page.goto(`${projectUrl}/${path}`);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }).first(),
      ).toBeVisible();
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
    }
    await page.goto(`${projectUrl}/tree`);
    await page
      .getByRole("region", { name: "工作分工列表", exact: true })
      .getByRole("button")
      .first()
      .click();
    await page.getByRole("button", { name: "查看工作", exact: true }).click();
    const overview = page.getByRole("tab", { name: "概要", exact: true });
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    const dependency = page.getByRole("tab", { name: "依赖", exact: true });
    await expect(dependency).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dependencies$/u);
    await expect(dependency).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toBeVisible();
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    if (width < 768) {
      const trigger = page.getByRole("button", { name: "更多", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "更多", exact: true });
      await expect(menu).toBeVisible();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("menuitem", { name: "断开连接", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.getByRole("menuitem", { name: "用量", exact: true }).click();
      await expect(page).toHaveURL(`${projectUrl}/usage`);
      await expect(
        page.getByRole("heading", { name: "用量", exact: true }),
      ).toBeVisible();
    }
  }
  expect(fixture.daemonErrors).toEqual([]);
});
