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
  await page.getByLabel("项目名称").fill("功能测试项目");
  await page.getByRole("button", { name: "创建项目" }).click();

  await expect(page).toHaveURL(/\/p\/prj_[A-Za-z0-9-]+$/u);
  await expect(page.getByRole("heading", { name: "对话" })).toBeVisible();
  await expect(page.getByLabel("消息")).toBeEditable();

  await page.getByLabel("消息").fill(`你好 ${marker}`);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText(`你好 ${marker}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`已收到 ${marker}`, { exact: true })).toBeVisible(
    {
      timeout: 30_000,
    },
  );

  expect(
    fixture.providerCalls.some((call) =>
      JSON.stringify(call.messages).includes(marker),
    ),
  ).toBe(true);
  const callsBeforeRestart = fixture.providerCalls.length;

  await fixture.restart();
  await page.reload();
  await expect(page.getByText(`你好 ${marker}`, { exact: true })).toBeVisible();
  await expect(
    page.getByText(`已收到 ${marker}`, { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(fixture.providerCalls).toHaveLength(callsBeforeRestart);
  expect(fixture.daemonErrors).toEqual([]);
});
