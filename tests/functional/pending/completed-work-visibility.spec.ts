import { expect, test } from "@playwright/test";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
} from "../support/public-client.js";
import { makeWorkProvider } from "../support/work-provider.js";

let fixture: ProductionFixture;
let projectId: string;
const marker = `F22-COMPLETED-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

test.beforeAll(async () => {
  fixture = await startProductionFixture({
    reply: makeWorkProvider({ marker, verdict: "Pass" }),
  });
  const project = await createFunctionalProject(
    makePublicClient(fixture.baseUrl),
    fixture.workspaceDirectory,
    "F22 完成状态可见性",
  );
  projectId = project.projectId;
});

test.afterAll(async () => {
  await fixture.stop();
});

test("F22 a completed Work remains visible from its original page", async ({
  page,
}) => {
  await page.goto(`${fixture.baseUrl}/p/${projectId}`);
  await page
    .getByLabel("消息")
    .fill(`请完成目标 ${marker}，读取 proof.txt 并独立验证。`);
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "待处理" }).click();
  await expect(page.getByRole("button", { name: "批准并继续" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "批准并继续" }).click();
  await expect(page.getByText("等待验收").first()).toBeVisible({
    timeout: 45_000,
  });

  await page.getByRole("button", { name: "查看工作与验证" }).click();
  await expect(page).toHaveURL(/\/workspace\/ws_[^/]+\/work\/wrk_[^/]+$/u);
  const workUrl = page.url();
  await expect(page.getByText(`Complete ${marker}.`)).toBeVisible();

  await page.getByRole("button", { name: "待处理" }).click();
  await page.getByRole("button", { name: "验收成果" }).click();
  await page.getByRole("button", { name: "记录验收" }).click();
  await expect(page.getByText("没有等你处理的事项")).toBeVisible({
    timeout: 30_000,
  });

  await page.goto(workUrl);
  await expect(page.getByText("已完成", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(`Complete ${marker}.`)).toBeVisible();
  await expect(page.getByText("acceptance", { exact: true })).toBeVisible();
  expect(fixture.daemonErrors).toEqual([]);
});
