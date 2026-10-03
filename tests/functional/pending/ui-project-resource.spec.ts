import { expect, test } from "@playwright/test";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { makeWorkProvider } from "../support/work-provider.js";

let fixture: ProductionFixture;
const marker = `F21-UI-RESOURCE-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

test.beforeAll(async () => {
  fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: makeWorkProvider({ marker, verdict: "Pass" }),
  });
});

test.afterAll(async () => {
  await fixture.stop();
});

test("F21 browser-created project completes an evidence-based Work", async ({
  page,
}) => {
  await page.goto(fixture.baseUrl);
  await page.getByLabel("项目名称").fill("F21 浏览器新建项目");
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page).toHaveURL(/\/p\/prj_[A-Za-z0-9-]+$/u);

  await page
    .getByLabel("消息")
    .fill(`请完成目标 ${marker}，读取 proof.txt 并独立验证。`);
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "待处理" }).click();
  await expect(page.getByRole("button", { name: "批准并继续" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "批准并继续" }).click();

  try {
    await expect(page.getByText("等待验收").first()).toBeVisible({
      timeout: 25_000,
    });
  } catch (error) {
    const observations = fixture.providerCalls
      .at(-1)
      ?.messages.filter((message) => message.role === "tool")
      .slice(-3)
      .map((message) => message.content?.slice(0, 200));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; latestToolResults=${JSON.stringify(observations ?? [])}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  }
  await page.getByRole("button", { name: "验收成果" }).click();
  await page.getByRole("button", { name: "记录验收" }).click();
  await expect(page.getByText("没有等你处理的事项")).toBeVisible({
    timeout: 30_000,
  });
  expect(fixture.daemonErrors).toEqual([]);
});
