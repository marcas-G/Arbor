// Shared P38 fixture startup — moved verbatim from
// p38-executable-approval-public.functional.test.ts (B5 split).
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForExecutableApproval,
  waitForPublic,
} from "../../../support/public-client.js";
import {
  createTrustedLocalP11FixtureEnvironment,
  grantTrustedLocalP11Permission,
  initializeTrustedLocalP11Worktree,
} from "../../../support/trusted-local-fixture.js";
import { readApprovalSnapshot } from "./snapshot.js";

export const fixtures: ProductionFixture[] = [];
export const p4FenceChild = resolve(
  "tests/functional/support/tool-lease-fencing-child.mjs",
);
export const sandboxPolicyV2DaemonChild = resolve(
  "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
);

export interface ApprovalFixtureQualificationOptions {
  readonly firstDaemonEntry?: string;
  readonly daemonEnvironment?: Readonly<Record<string, string>>;
  readonly onDaemonStdout?: (line: string) => void;
  readonly preserveDirectoryOnStop?: boolean;
  readonly trustedLocalSandboxPolicy?: boolean;
}

export const p38AfterEach = async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
};

export const startExecutableApproval = async (
  marker: string,
  qualification: ApprovalFixtureQualificationOptions = {},
) => {
  const destination = `p38-moved-${marker}.txt`;
  const effectLog = `p38-effects-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${marker}'; mv -LiteralPath 'proof.txt' -Destination '${destination}'; Write-Output '${marker}' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${marker}' >> '${effectLog}' && mv proof.txt '${destination}' && printf '%s\\n' '${marker}'; fi`;

  const trustedLocalFixture = createTrustedLocalP11FixtureEnvironment();
  let releaseShellAction!: () => void;
  let markShellActionRequested!: () => void;
  const shellActionGate = new Promise<void>((resolveGate) => {
    releaseShellAction = resolveGate;
  });
  const shellActionRequested = new Promise<void>((resolveRequest) => {
    markShellActionRequested = resolveRequest;
  });
  const daemonEnvironment = trustedLocalFixture.daemonEnvironment;
  daemonEnvironment.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION = "1";
  Object.assign(daemonEnvironment, qualification.daemonEnvironment ?? {});
  daemonEnvironment.ARBOR_TICK_INTERVAL_MS = "25";
  daemonEnvironment.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION = "1";
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    daemonEnvironment,
    setupProbe: trustedLocalFixture.setupProbe,
    ...(qualification.trustedLocalSandboxPolicy === true
      ? {
          beforeResponse: async (call) => {
            const requestedShell = call.tools.some(
              (tool) => tool.function?.name === "shell",
            );
            if (requestedShell) {
              markShellActionRequested();
              await shellActionGate;
            }
          },
        }
      : {}),
    firstDaemonEntry:
      qualification.firstDaemonEntry ?? sandboxPolicyV2DaemonChild,
    ...(qualification.onDaemonStdout === undefined
      ? {}
      : { onDaemonStdout: qualification.onDaemonStdout }),
    ...(qualification.preserveDirectoryOnStop === true
      ? { preserveDirectoryOnStop: true }
      : {}),
    reply: (call) => {
      const names = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      const context = JSON.stringify(call.messages);
      if (
        names.has("assign_work") &&
        !names.has("claim_completion") &&
        context.includes(marker)
      ) {
        if (context.includes("WorkAssigned(")) {
          return { _tag: "Text", text: `Work admitted for ${marker}` };
        }
        return {
          _tag: "ToolCall",
          name: "assign_work",
          arguments: {
            objective: `Move proof.txt and write ${marker} exactly once.`,
            why: "qualify durable Executable approval",
            constraints: ["do not access external resources"],
            completionExpectation: "the approved shell action is reconciled",
            verificationMission: {
              goal: `Verify the approved action ${marker}`,
              criteria: [
                {
                  criterionId: "approved-effect",
                  requirement: `the effect log contains ${marker} once`,
                  required: true,
                },
              ],
              riskRequirements: ["no external side effects"],
            },
            reason: "P38 executable approval functional qualification",
          },
        };
      }
      if (
        names.has("shell") &&
        names.has("claim_completion") &&
        context.includes(marker)
      ) {
        const effectReturned = call.messages.some(
          (message) =>
            message.role === "tool" && message.content?.includes(marker),
        );
        return effectReturned
          ? { _tag: "Text", text: `Observed approved effect ${marker}` }
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
  fixtures.push(fixture);
  if (qualification.preserveDirectoryOnStop === true) {
    console.info(
      `P38 retained process fixture: marker=${marker} directory=${fixture.directory} database=${fixture.databaseFile} workspace=${fixture.workspaceDirectory}`,
    );
  }

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `P38 executable approval ${marker}`,
    { resourceSelection: "Profile" },
  );
  const sandboxPolicyExpiresAt = new Date(
    Date.now() + 60 * 60_000,
  ).toISOString();
  if (qualification.trustedLocalSandboxPolicy === true) {
    await initializeTrustedLocalP11Worktree({
      databaseFile: fixture.databaseFile,
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      path: fixture.workspaceDirectory,
    });
  }
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
    `请完成 ${marker}：把 proof.txt 移到 ${destination}，并在副作用日志中记录一次。`,
  );

  const workApproval = await waitForApproval(client, project, marker).catch(
    (error: unknown) => {
      throw new Error(
        `P38 Work admission did not reach public approval: ${String(error)}; providerCalls=${JSON.stringify(fixture.providerCalls.map((call) => ({ tools: call.tools.map((tool) => tool.function?.name), messages: call.messages.map((message) => ({ role: message.role, content: message.content?.slice(0, 600) })) })))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        { cause: error },
      );
    },
  );
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: workApproval.approvalId,
    expectedRevision: workApproval.revision,
    decision: "Approve",
    reason: "admit the Work whose shell action is separately gated",
  });

  if (qualification.trustedLocalSandboxPolicy === true) {
    await shellActionRequested;
    const activeWork = await waitForPublic(
      () =>
        client.view<{
          readonly activeExecution?: { readonly executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) => work?.activeExecution?.executionId !== undefined,
    );
    const executionId = activeWork?.activeExecution?.executionId;
    if (executionId === undefined) {
      throw new Error("P38 Work had no active Execution for P1 grant setup");
    }
    try {
      await grantTrustedLocalP11Permission({
        client,
        projectId: project.projectId,
        executionId,
        expiresAt: sandboxPolicyExpiresAt,
      });
    } catch (error) {
      const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
      let execution: unknown;
      try {
        execution = db
          .prepare(
            "SELECT execution_id, project_id, workspace_id, stop_requested_at, settlement_kind, settled_at FROM executions WHERE execution_id = ?",
          )
          .get(executionId);
      } finally {
        db.close();
      }
      throw new Error(
        `P38 TrustedLocal P1 grant failed: ${String(error)}; execution=${JSON.stringify(execution)}; daemon=${fixture.daemonErrors.join(" | ")}`,
        { cause: error },
      );
    }
    releaseShellAction();
  }

  const { approvalId, revision } = await waitForExecutableApproval(
    client,
    project.rootWorkspaceId,
    marker,
    60_000,
  );
  const snapshot = () =>
    readApprovalSnapshot(
      fixture.databaseFile,
      fixture.workspaceDirectory,
      approvalId,
      effectLog,
    );
  const before = snapshot();
  if (before.approval === undefined || before.step === undefined) {
    throw new Error(
      `P38 approval did not bind a durable AgentLoopStep for ${marker}`,
    );
  }
  expect(before.approval.state).toBe("Pending");
  expect(before.approval.revision).toBe(0);
  expect(before.invocation).toBeUndefined();
  expect(before.effectCount).toBe(0);

  return {
    client,
    fixture,
    project,
    approvalId,
    revision,
    marker,
    effectLog,
    before,
    snapshot,
    sandboxPolicyExpiresAt,
  };
};
