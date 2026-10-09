import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
let rootWorkspaceId: string;
let foreignProjectId: string;
let foreignRootWorkspaceId: string;
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
  rootWorkspaceId = project.rootWorkspaceId;
  const foreignWorkspaceDirectory = join(fixture.directory, "foreign-project");
  await mkdir(foreignWorkspaceDirectory, { recursive: true });
  const foreignProject = await createFunctionalProject(
    makePublicClient(fixture.baseUrl),
    foreignWorkspaceDirectory,
    "F22 外部身份范围",
  );
  foreignProjectId = foreignProject.projectId;
  foreignRootWorkspaceId = foreignProject.rootWorkspaceId;
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

  const workId = /\/work\/(wrk_[^/]+)$/u.exec(workUrl)?.[1];
  if (workId === undefined) throw new Error("original Work URL has no WorkId");
  const verification = await makePublicClient(fixture.baseUrl).view<{
    verificationId?: string;
    verdict?: string;
    acceptance?: { acceptanceId: string };
  }>("verification", { workId });
  expect(verification.verdict).toBe("Pass");
  const acceptanceId = verification.acceptance?.acceptanceId;
  const verificationId = verification.verificationId;
  if (acceptanceId === undefined || verificationId === undefined) {
    throw new Error("public Verification has no exact acceptance binding");
  }
  expect(acceptanceId).toMatch(/^acc_/u);

  const requestWorkDetail = async (target: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly workId: string;
  }) => {
    const response = await page.request.post(
      `${fixture.baseUrl}/views/work-detail`,
      {
        headers: { authorization: "Bearer local" },
        data: target,
      },
    );
    return {
      status: response.status(),
      body: (await response.json()) as {
        readonly problem?: Record<string, unknown>;
      },
    };
  };
  const missing = await requestWorkDetail({
    projectId,
    workspaceId: rootWorkspaceId,
    workId: `wrk_${crypto.randomUUID()}`,
  });
  const foreignWorkspace = await requestWorkDetail({
    projectId,
    workspaceId: foreignRootWorkspaceId,
    workId,
  });
  const foreignProject = await requestWorkDetail({
    projectId: foreignProjectId,
    workspaceId: foreignRootWorkspaceId,
    workId,
  });
  expect(missing.status).toBe(404);
  expect(foreignWorkspace.status).toBe(404);
  expect(foreignProject.status).toBe(404);
  expect(foreignWorkspace.body.problem).toEqual(missing.body.problem);
  expect(foreignProject.body.problem).toEqual(missing.body.problem);
  expect(missing.body.problem).toEqual({
    code: "projection/work-not-found",
    category: "not-found",
    message: "projection/work-not-found",
    correlationId: null,
    retryDisposition: "non-retryable",
    safeDetails: {},
  });

  const privacyPage = await page.context().newPage();
  const viewRequests: Array<{
    readonly view: string;
    readonly request: unknown;
  }> = [];
  await privacyPage.route(`${fixture.baseUrl}/views/**`, async (route) => {
    const url = new URL(route.request().url());
    viewRequests.push({
      view: url.pathname.split("/").at(-1) ?? "",
      request: route.request().postDataJSON(),
    });
    await route.continue();
  });
  const workRoute = (
    routeProject: string,
    routeWorkspace: string,
    id: string,
  ) =>
    `${fixture.baseUrl}/p/${routeProject}/workspace/${routeWorkspace}/work/${id}`;
  for (const target of [
    { projectId, workspaceId: foreignRootWorkspaceId, workId },
    {
      projectId: foreignProjectId,
      workspaceId: foreignRootWorkspaceId,
      workId,
    },
    {
      projectId,
      workspaceId: rootWorkspaceId,
      workId: `wrk_${crypto.randomUUID()}`,
    },
  ]) {
    viewRequests.length = 0;
    await privacyPage.goto(
      workRoute(target.projectId, target.workspaceId, target.workId),
    );
    await expect(privacyPage.getByText("对象不存在")).toBeVisible();
    expect(viewRequests.length).toBeGreaterThan(0);
    for (const { view, request } of viewRequests) {
      expect(view).toBe("work-detail");
      expect(request).toEqual(target);
    }
    await expect(privacyPage.getByText(`Complete ${marker}.`)).toHaveCount(0);
  }
  await privacyPage.close();
  await fixture.restart();

  await page.goto(workUrl);
  await expect(page.getByText("已完成", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(`Complete ${marker}.`)).toBeVisible();
  await expect(page.getByText("验收记录", { exact: true })).toBeVisible();
  await expect(page.getByText(acceptanceId).first()).toBeVisible();
  await expect(page.getByText(verificationId).first()).toBeVisible();
  await expect(page.getByText("治理动作")).toHaveCount(0);
  expect(fixture.daemonErrors).toEqual([]);
});
