import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { functionalId, makePublicClient } from "../support/public-client.js";
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

test("F21 browser Profile selection reaches file evidence, Verification PASS, and Acceptance", async ({
  page,
}) => {
  const client = makePublicClient(fixture.baseUrl);
  const catalog = await client.projectResources();
  const available = catalog.profiles.filter((profile) => profile.available);
  expect(available).toHaveLength(1);
  const selectedProfile = available[0];
  if (selectedProfile === undefined) {
    throw new Error("F21 host Profile was not available");
  }

  await page.goto(fixture.baseUrl);
  const profileChoice = page.getByRole("radio", {
    name: /Project files.*可用/u,
  });
  await expect(profileChoice).toBeVisible();
  await expect(profileChoice).toBeChecked();
  await expect(page.getByText(selectedProfile.resourceProfileRef)).toHaveCount(
    0,
  );
  await expect(page.getByText(selectedProfile.version)).toHaveCount(0);
  await expect(page.getByText(fixture.workspaceDirectory)).toHaveCount(0);
  await page.getByLabel("项目名称").fill("F21 浏览器资源项目");
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

  await expect(page.getByText("等待验收").first()).toBeVisible({
    timeout: 45_000,
  });
  const toolOutputs = fixture.providerCalls.flatMap((call) =>
    call.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content ?? ""),
  );
  expect(JSON.stringify(toolOutputs)).toContain("FUNCTIONAL_VERIFIED");

  await page.getByRole("button", { name: "验收成果" }).click();
  await page.getByRole("button", { name: "记录验收" }).click();
  await expect(page.getByText("没有等你处理的事项")).toBeVisible({
    timeout: 30_000,
  });
  expect(fixture.daemonErrors).toEqual([]);
});

test("F21 public requests reject forged refs and free paths without creating Projects", async ({
  page,
}) => {
  await page.goto(fixture.baseUrl);
  const freeDirectory = join(fixture.directory, "unregistered-client-path");
  mkdirSync(freeDirectory);
  const providerCallsBefore = fixture.providerCalls.length;
  const projectCount = async (): Promise<number> =>
    page.evaluate(async () => {
      const response = await fetch("/projects", {
        headers: { authorization: "Bearer local" },
      });
      const body = (await response.json()) as {
        body?: { projects?: ReadonlyArray<{ projectId: string }> };
      };
      return body.body?.projects?.length ?? -1;
    });
  const before = await projectCount();
  const workspaceId = functionalId("ws");
  const basePayload = (
    name: string,
    resourceSelection: Record<string, string> = {
      _tag: "Profile",
      resourceProfileRef: "not-registered",
      version: "v1",
    },
  ) => ({
    name,
    revision: 0,
    projectPolicy: {},
    projectPolicyRevision: 0,
    defaultConfiguration: {},
    environmentRef: "local",
    rootWorkspaceId: workspaceId,
    primarySession: { sessionId: functionalId("ses"), contextEpoch: 0 },
    rootWorkspace: {
      name: "root",
      responsibilityDefinition: {
        purpose: name,
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceSelection,
      agentBinding: { _tag: "ResponsibilityBoundAgentBinding", workspaceId },
      workspacePolicy: {},
      workspacePolicyRevision: 0,
      revision: 0,
    },
  });
  const post = async (
    projectId: string,
    payload: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    return page.evaluate(
      async ({ projectId: id, payload: requestPayload, commandId }) => {
        const result = await fetch("/commands", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer local",
          },
          body: JSON.stringify({
            commandType: "CreateProject",
            commandId,
            projectId: id,
            actor: "user:local",
            issuedAt: "2026-10-10T00:00:00.000Z",
            payload: requestPayload,
          }),
        });
        return { status: result.status, body: await result.json() };
      },
      { projectId, payload, commandId: functionalId("cmd") },
    );
  };

  const forged = await post(
    functionalId("prj"),
    basePayload("F21 forged Profile"),
  );
  const rawPayload = basePayload("F21 raw path", {
    _tag: "ConversationOnly",
  });
  Object.assign(rawPayload.rootWorkspace, {
    resourceBoundary: {
      basisResponsibilityRevision: 0,
      addresses: [{ _tag: "FileTree", path: freeDirectory }],
    },
    resourceBoundaryRevision: 0,
  });
  const rawPath = await post(functionalId("prj"), rawPayload);
  const after = await projectCount();

  expect(forged.status).toBe(200);
  expect(forged.body).toMatchObject({
    ok: true,
    body: {
      resolution: "TerminalRejected",
      rejection: "ProjectResourceUnavailable",
    },
  });
  expect(rawPath.status).toBe(400);
  expect(JSON.stringify([forged.body, rawPath.body])).not.toContain(
    freeDirectory,
  );
  expect(after).toBe(before);
  expect(fixture.providerCalls).toHaveLength(providerCallsBefore);
  expect(fixture.daemonErrors).toEqual([]);
});
