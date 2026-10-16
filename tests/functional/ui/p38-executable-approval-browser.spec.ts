import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const startQueueApproval = async (marker: string) => {
  const effectLog = `p38-browser-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${marker}'; mv -LiteralPath 'proof.txt' -Destination 'p38-browser-${marker}.txt' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${marker}' >> '${effectLog}' && mv proof.txt 'p38-browser-${marker}.txt'; fi`;
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
                objective: `Move proof.txt for ${marker}.`,
                why: "qualify browser rejection/expiry of an Executable action",
                constraints: [],
                completionExpectation: "the exact shell action is resolved",
                verificationMission: {
                  goal: `Verify browser action ${marker}`,
                  criteria: [
                    {
                      criterionId: "no-effect",
                      requirement: `the shell effect log remains absent for ${marker}`,
                      required: true,
                    },
                  ],
                  riskRequirements: [],
                },
                reason: "P38 browser rejection/expiry qualification",
              },
            };
      }
      if (tools.has("shell") && context.includes(marker)) {
        return {
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
    `P38 browser rejection ${marker}`,
    { resourceSelection: "Profile" },
  );
  await client.command(project.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
    capability: "shell:exec",
    target: project.rootWorkspaceId,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  await submitHumanMessage(client, project, `完成 ${marker}。`);
  const workApproval = await waitForApproval(client, project, marker);
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: workApproval.approvalId,
    expectedRevision: workApproval.revision,
    decision: "Approve",
    reason: "start the Work before the Executable decision",
  });
  const inbox = await waitForPublic(
    () =>
      client.view<{
        unconsumed: Array<{
          entryKey: string;
          kind: string;
          target?: {
            kind: string;
            approvalId: string;
            revision: number;
            toolName: string;
            toolVersion: string;
            executionId: string;
            targetResourceSpaceIds: ReadonlyArray<string>;
            capabilities: ReadonlyArray<string>;
            sideEffectSemantics: string;
            actionDigest: string;
            validatedArgumentsPreview: string;
            expiresAt: string;
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
  const entry = inbox.unconsumed.find(
    (candidate) =>
      candidate.kind === "Governance" &&
      EXECUTABLE_APPROVAL_ENTRY_KEY.test(candidate.entryKey) &&
      candidate.target?.kind === "ExecutableApproval",
  );
  if (entry?.target === undefined) {
    throw new Error("P38 executable approval was absent from Queue Inbox");
  }
  return { client, project, target: entry.target, effectLog };
};

test("P38 executable approval can be resolved from the browser Queue and resumes the same action", async ({
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
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
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

test("P38 Queue Reject resumes the same action without an effect", async ({
  page,
}) => {
  const marker = `P38-BROWSER-REJECT-${crypto.randomUUID().slice(0, 8)}`;
  const run = await startQueueApproval(marker);
  await page.goto(`${fixture?.baseUrl}/p/${run.project.projectId}`);
  await page.getByRole("button", { name: "待处理" }).click();
  const approvalDetails = page.getByLabel("待处理详情");
  await expect(approvalDetails).toContainText(run.target.executionId);
  const decision = page.getByLabel("审批决定");
  await decision.selectOption("Reject");
  await expect(decision).toHaveValue("Reject");
  await page.getByRole("button", { name: "拒绝动作" }).click();
  await expect
    .poll(
      () => {
        const db = new DatabaseSync(fixture?.databaseFile ?? "", {
          readOnly: true,
        });
        try {
          return db
            .prepare(
              "SELECT state, revision FROM action_approvals WHERE approval_id = ?",
            )
            .get(run.target.approvalId);
        } finally {
          db.close();
        }
      },
      { timeout: 45_000 },
    )
    .toEqual({ state: "Rejected", revision: run.target.revision + 1 });

  await expect
    .poll(
      () =>
        run.client.view<{
          unconsumed: Array<{ entryKey: string }>;
        }>("inbox-view", { workspaceId: run.project.rootWorkspaceId }),
      { timeout: 45_000 },
    )
    .toMatchObject({
      unconsumed: expect.not.arrayContaining([
        expect.objectContaining({
          entryKey: expect.stringContaining(run.target.approvalId),
        }),
      ]),
    });
  const db = new DatabaseSync(fixture?.databaseFile ?? "", { readOnly: true });
  try {
    const approval = db
      .prepare(
        "SELECT state, revision, execution_id, logical_step_no, repair_attempt, action_index, logical_action_id FROM action_approvals WHERE approval_id = ?",
      )
      .get(run.target.approvalId) as
      | {
          readonly state: string;
          readonly revision: number;
          readonly execution_id: string;
          readonly logical_step_no: number;
          readonly repair_attempt: number;
          readonly action_index: number;
          readonly logical_action_id: string;
        }
      | undefined;
    if (approval === undefined) throw new Error("approval row disappeared");
    await expect
      .poll(
        () => {
          const currentAction = db
            .prepare(
              `SELECT state FROM agent_loop_step_actions
                WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?
                  AND action_index = ? AND logical_action_id = ?`,
            )
            .get(
              approval.execution_id,
              approval.logical_step_no,
              approval.repair_attempt,
              approval.action_index,
              approval.logical_action_id,
            ) as { readonly state: string } | undefined;
          const currentInvocation = db
            .prepare(
              "SELECT effect_admission_state, settlement_kind FROM tool_invocations WHERE approval_id = ?",
            )
            .get(run.target.approvalId) as
            | {
                readonly effect_admission_state: string;
                readonly settlement_kind: string | null;
              }
            | undefined;
          return {
            action: currentAction?.state,
            invocation: currentInvocation,
          };
        },
        { timeout: 45_000 },
      )
      .toMatchObject({
        action: "TerminalRejected",
        invocation: {
          effect_admission_state: "NotAdmitted",
          settlement_kind: "Denied",
        },
      });
    const action = db
      .prepare(
        `SELECT state FROM agent_loop_step_actions
          WHERE execution_id = ? AND logical_step_no = ? AND repair_attempt = ?
            AND action_index = ? AND logical_action_id = ?`,
      )
      .get(
        approval.execution_id,
        approval.logical_step_no,
        approval.repair_attempt,
        approval.action_index,
        approval.logical_action_id,
      ) as { readonly state: string } | undefined;
    const invocation = db
      .prepare(
        "SELECT effect_admission_state, settlement_kind, settlement_json FROM tool_invocations WHERE approval_id = ?",
      )
      .get(run.target.approvalId) as
      | {
          readonly effect_admission_state: string;
          readonly settlement_kind: string | null;
          readonly settlement_json: string | null;
        }
      | undefined;
    const resolvedEvents = db
      .prepare(
        "SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_ref = ? AND event_type = 'ExecutableApprovalResolved'",
      )
      .get(run.target.approvalId) as { readonly count: number };
    expect(approval).toMatchObject({
      state: "Rejected",
      revision: run.target.revision + 1,
    });
    expect(action?.state).toBe("TerminalRejected");
    expect(invocation).toMatchObject({
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
    });
    expect(JSON.parse(invocation?.settlement_json ?? "{}")).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalRejected",
    });
    expect(resolvedEvents.count).toBe(1);
    expect(
      existsSync(join(fixture?.workspaceDirectory ?? "", run.effectLog)),
    ).toBe(false);
    expect(fixture?.daemonErrors).toEqual([]);
  } finally {
    db.close();
  }
});

test("P38 Queue renders an expired approval and recovers without an effect", async ({
  page,
}) => {
  const marker = `P38-BROWSER-EXPIRE-${crypto.randomUUID().slice(0, 8)}`;
  const run = await startQueueApproval(marker);
  const db = new DatabaseSync(fixture?.databaseFile ?? "");
  try {
    db.prepare(
      "UPDATE action_approvals SET expires_at = ? WHERE approval_id = ? AND route_kind = 'Executable' AND state = 'Pending' AND revision = ?",
    ).run(
      "2000-01-01T00:00:00.000Z",
      run.target.approvalId,
      run.target.revision,
    );
  } finally {
    db.close();
  }

  await page.goto(`${fixture?.baseUrl}/p/${run.project.projectId}`);
  await page.getByRole("button", { name: "待处理" }).click();
  const approvalDetails = page.getByLabel("待处理详情");
  await expect(approvalDetails).toContainText(run.target.executionId);
  await expect(approvalDetails).toContainText(
    "此工具动作审批已过期，不能再批准或拒绝。",
  );
  await expect(page.getByLabel("审批决定")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "批准并继续" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "拒绝动作" })).toHaveCount(0);

  await expect
    .poll(
      () => {
        const readDb = new DatabaseSync(fixture?.databaseFile ?? "", {
          readOnly: true,
        });
        try {
          const row = readDb
            .prepare(
              `SELECT a.state, t.effect_admission_state, t.settlement_kind,
                      t.settlement_json
                 FROM action_approvals AS a
                 LEFT JOIN tool_invocations AS t ON t.approval_id = a.approval_id
                WHERE a.approval_id = ?`,
            )
            .get(run.target.approvalId) as
            | {
                readonly state: string;
                readonly effect_admission_state: string | null;
                readonly settlement_kind: string | null;
                readonly settlement_json: string | null;
              }
            | undefined;
          return row;
        } finally {
          readDb.close();
        }
      },
      { timeout: 45_000 },
    )
    .toMatchObject({
      state: "Expired",
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
    });
  const finalDb = new DatabaseSync(fixture?.databaseFile ?? "", {
    readOnly: true,
  });
  try {
    const state = finalDb
      .prepare(
        "SELECT settlement_json FROM tool_invocations WHERE approval_id = ?",
      )
      .get(run.target.approvalId) as { readonly settlement_json: string };
    expect(JSON.parse(state.settlement_json)).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalExpired",
    });
    expect(
      finalDb
        .prepare(
          "SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_ref = ? AND event_type = 'ExecutableApprovalResolved'",
        )
        .get(run.target.approvalId),
    ).toEqual({ count: 1 });
  } finally {
    finalDb.close();
  }
  await expect
    .poll(() =>
      existsSync(join(fixture?.workspaceDirectory ?? "", run.effectLog)),
    )
    .toBe(false);
  await expect.poll(() => fixture?.daemonErrors ?? []).toEqual([]);
});

const requireEffectCount = (workspaceDirectory: string, effectLog: string) =>
  readFileSync(join(workspaceDirectory, effectLog), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0).length;
