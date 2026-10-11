import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

let fixture: ProductionFixture | undefined;

test.afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

test.skip("P38 executable approval can be resolved from the browser Queue and resumes the same action", async ({
  page,
}) => {
  const marker = `P38-BROWSER-${crypto.randomUUID().slice(0, 8)}`;
  const destination = `p38-browser-${marker}.txt`;
  const effectLog = `p38-browser-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${marker}'; mv -LiteralPath 'proof.txt' -Destination '${destination}' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${marker}' >> '${effectLog}' && mv proof.txt '${destination}'; fi`;
  fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: (call) => {
      const tools = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      const context = JSON.stringify(call.messages);
      if (
        tools.has("assign_work") &&
        !tools.has("claim_completion") &&
        context.includes(marker)
      ) {
        return context.includes("WorkAssigned(")
          ? { _tag: "Text", text: `Work admitted for ${marker}` }
          : {
              _tag: "ToolCall",
              name: "assign_work",
              arguments: {
                objective: `Move proof.txt and record ${marker} once.`,
                why: "qualify browser Executable approval",
                constraints: [],
                completionExpectation:
                  "the exact approved shell action runs once",
                verificationMission: {
                  goal: `Verify browser approval ${marker}`,
                  criteria: [
                    {
                      criterionId: "single-effect",
                      requirement: `${effectLog} contains ${marker} once`,
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "P38 browser approval test",
              },
            };
      }
      if (
        tools.has("shell") &&
        tools.has("claim_completion") &&
        context.includes(marker)
      ) {
        const effectReturned = call.messages.some(
          (message) =>
            message.role === "tool" && message.content?.includes(marker),
        );
        return effectReturned
          ? { _tag: "Text", text: `Observed ${marker}` }
          : {
              _tag: "ToolCall",
              name: "shell",
              arguments: {
                command,
                cwd: { mount: "workspace", path: "." },
                timeoutMs: 5_000,
              },
            };
      }
      return { _tag: "Text", text: `Waiting for ${marker}` };
    },
  });

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `P38 browser approval ${marker}`,
    { resourceSelection: "Profile" },
  );
  await client.command(project.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
    capability: "shell:exec",
    target: project.rootWorkspaceId,
    expiresAt: null,
  });
  await submitHumanMessage(
    client,
    project,
    `完成 ${marker}：移动 proof.txt，并在日志里记一次。`,
  );
  const workApproval = await waitForApproval(client, project, marker);
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: workApproval.approvalId,
    expectedRevision: workApproval.revision,
    decision: "Approve",
    reason: "start the Work before its separately gated shell action",
  });
  await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" && /^eap:[^:]+:0$/u.test(entry.entryKey),
      ),
    60_000,
  );

  await page.goto(`${fixture.baseUrl}/p/${project.projectId}`);
  await page.getByRole("button", { name: "待处理" }).click();
  await expect(
    page.getByRole("heading", { name: "待处理", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("审批决定").selectOption("Approve");
  await page.getByRole("button", { name: "批准并继续" }).click();

  await expect
    .poll(
      () =>
        existsSync(join(fixture?.workspaceDirectory ?? "", effectLog))
          ? requireEffectCount(fixture?.workspaceDirectory ?? "", effectLog)
          : 0,
      { timeout: 45_000 },
    )
    .toBe(1);
  await expect.poll(() => fixture?.daemonErrors ?? []).toEqual([]);
});

const requireEffectCount = (workspaceDirectory: string, effectLog: string) =>
  readFileSync(join(workspaceDirectory, effectLog), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0).length;
