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
const EXECUTABLE_APPROVAL_ENTRY_KEY = /^eap:.+:\d+$/u;

test.afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

test.skip("P38 executable approval can be resolved from the browser Queue and resumes the same action", async ({
  page,
}) => {
  const marker = `P38-BROWSER-${crypto.randomUUID().slice(0, 8)}`;
  const secretCanary = `P38-SHELL-CANARY-${crypto.randomUUID()}`;
  const destination = `p38-browser-${marker}.txt`;
  const effectLog = `p38-browser-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${secretCanary}'; mv -LiteralPath 'proof.txt' -Destination '${destination}' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${secretCanary}' >> '${effectLog}' && mv proof.txt '${destination}'; fi`;
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
  const approvalInbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{
          entryKey: string;
          kind: string;
          summary: string;
          target?: {
            readonly kind: string;
            readonly approvalId: string;
            readonly revision: number;
            readonly toolName: string;
            readonly toolVersion: string;
            readonly executionId: string;
            readonly capabilities: ReadonlyArray<string>;
            readonly sideEffectSemantics: string;
            readonly actionDigest: string;
            readonly validatedArgumentsPreview: string;
          };
        }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
    (value) =>
      value.unconsumed.some(
        (entry) =>
          entry.kind === "Governance" &&
          EXECUTABLE_APPROVAL_ENTRY_KEY.test(entry.entryKey) &&
          entry.target?.kind === "ExecutableApproval",
      ),
    60_000,
  );
  const approvalEntry = approvalInbox.unconsumed.find(
    (entry) =>
      entry.kind === "Governance" &&
      EXECUTABLE_APPROVAL_ENTRY_KEY.test(entry.entryKey) &&
      entry.target?.kind === "ExecutableApproval",
  );
  const entryIdentity =
    approvalEntry === undefined
      ? null
      : /^eap:(.+):(\d+)$/u.exec(approvalEntry.entryKey);
  if (
    approvalEntry === undefined ||
    approvalEntry.target === undefined ||
    entryIdentity === null ||
    entryIdentity[1] !== approvalEntry.target.approvalId ||
    Number(entryIdentity[2]) !== approvalEntry.target.revision
  ) {
    throw new Error(
      "Public Inbox returned no exact Executable approval target",
    );
  }
  const executableTarget = approvalEntry.target;
  expect(JSON.stringify(executableTarget)).not.toContain(secretCanary);
  expect(executableTarget.validatedArgumentsPreview).not.toContain(
    secretCanary,
  );
  expect(approvalEntry.summary).toBe("Executable approval requires review");

  await page.goto(`${fixture.baseUrl}/p/${project.projectId}`);
  await page.getByRole("button", { name: "待处理" }).click();
  await expect(
    page.getByRole("heading", { name: "待处理", exact: true }),
  ).toBeVisible();
  const approvalDetails = page.getByLabel("待处理详情");
  // The unique canary exists only in a free-form shell argument; locate the
  // review card by its safe target metadata and check the entire details DOM.
  await expect(
    page.getByRole("heading", { name: executableTarget.toolName, exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(approvalDetails).toContainText(executableTarget.toolVersion);
  await expect(approvalDetails).toContainText(executableTarget.executionId);
  await expect(approvalDetails).toContainText(executableTarget.actionDigest);
  await expect(approvalDetails).toContainText(
    executableTarget.capabilities.join("、"),
  );
  await expect(approvalDetails).toContainText(
    executableTarget.sideEffectSemantics,
  );
  await expect(approvalDetails).not.toContainText(secretCanary);
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
