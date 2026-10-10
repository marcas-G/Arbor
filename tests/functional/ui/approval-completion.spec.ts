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
const marker = `UI-APPROVAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

test.beforeAll(async () => {
  fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: makeWorkProvider({ marker, verdict: "Pass" }),
  });
  const project = await createFunctionalProject(
    makePublicClient(fixture.baseUrl),
    fixture.workspaceDirectory,
    "审批功能测试",
    { resourceSelection: "Profile" },
  );
  projectId = project.projectId;
});

test.afterAll(async () => {
  await fixture.stop();
});

test("F14/F15 user approves without IDs and accepts a verified Work", async ({
  page,
}) => {
  await page.goto(`${fixture.baseUrl}/p/${projectId}`);
  await expect(page.getByRole("heading", { name: "对话" })).toBeVisible();

  await page
    .getByLabel("消息")
    .fill(`请创建并完成目标 ${marker}，完成前必须独立验证。`);
  await page.getByRole("button", { name: "发送" }).click();

  await page.getByRole("button", { name: "待处理" }).click();
  await expect(
    page.getByRole("heading", { name: "待处理", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(marker).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "批准并继续" })).toBeVisible();
  await page.getByRole("button", { name: "批准并继续" }).click();

  try {
    await expect(page.getByText("等待验收").first()).toBeVisible({
      timeout: 45_000,
    });
  } catch (error) {
    const providerSummary = fixture.providerCalls.map((call) => ({
      tools: call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined),
      hasMarker: JSON.stringify(call.messages).includes(marker),
    }));
    const lastMessages = fixture.providerCalls
      .at(-1)
      ?.messages.slice(-6)
      .map((message) => ({
        role: message.role,
        content: message.content?.slice(0, 500),
      }));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; provider=${JSON.stringify(providerSummary)}; lastMessages=${JSON.stringify(lastMessages)}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  }
  await expect(page.getByText(marker).first()).toBeVisible();
  await page.getByRole("button", { name: "验收成果" }).click();
  await expect(page.getByRole("button", { name: "记录验收" })).toBeVisible();
  await page.getByRole("button", { name: "记录验收" }).click();

  await expect(page.getByText("没有等你处理的事项")).toBeVisible({
    timeout: 30_000,
  });
  expect(fixture.daemonErrors).toEqual([]);
});
