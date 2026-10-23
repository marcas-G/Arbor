import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../support/fixture-failure-evidence.js";
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
import { removeFunctionalFixtureDirectory } from "../support/schema44-bootstrap.js";
import {
  commitTrustedLocalP11Policy,
  createTrustedLocalP11FixtureEnvironment,
  grantTrustedLocalP11Permission,
  initializeTrustedLocalP11Worktree,
} from "../support/trusted-local-p11-fixture.js";

let fixture: ProductionFixture | undefined;
let fixtureFailureEvidence: (() => unknown) | undefined;
let preserveFixtureForFailure = false;
const EXECUTABLE_APPROVAL_ENTRY_KEY = /^eap:.+:\d+$/u;

test.afterEach(async ({ page: _page }, testInfo) => {
  const currentFixture = fixture;
  const captureFailureEvidence = fixtureFailureEvidence;
  const preserveForFailure = preserveFixtureForFailure;
  fixtureFailureEvidence = undefined;
  preserveFixtureForFailure = false;
  if (currentFixture === undefined) return;

  const failed = testInfo.status !== testInfo.expectedStatus;
  const beforeStop = failed ? captureFailureEvidence?.() : undefined;
  let stopError: unknown;
  try {
    await currentFixture.stop();
  } catch (error) {
    stopError = error;
  }
  const afterStop = failed ? captureFailureEvidence?.() : undefined;
  fixture = undefined;

  if (preserveForFailure) {
    if (failed) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      const evidence = {
        testName: testInfo.title,
        status: testInfo.status,
        expectedStatus: testInfo.expectedStatus,
        beforeStop,
        afterStop,
        stopError: stopError instanceof Error ? stopError.message : null,
        daemonErrors: currentFixture.daemonErrors,
        daemon: currentFixture.daemonProcessSnapshot(),
      };
      if (currentFixture.daemonsExited() && resultDirectory !== undefined) {
        try {
          const archivedDirectory = archiveProductionFixtureFailure({
            fixture: currentFixture,
            resultDirectory,
            artifactPrefix: "p38-browser-approval",
            evidence,
          });
          process.stderr.write(
            `[P38_BROWSER_FAILURE_ARTIFACT] ${JSON.stringify({ archivedDirectory })}\n`,
          );
        } catch (archiveError) {
          try {
            writeProductionFixtureArchiveSkipped({
              fixture: currentFixture,
              resultDirectory,
              evidence: {
                ...evidence,
                archiveError:
                  archiveError instanceof Error
                    ? archiveError.message
                    : String(archiveError),
              },
            });
          } catch (fallbackError) {
            process.stderr.write(
              `[P38_BROWSER_FAILURE_ARCHIVE_ERROR] ${JSON.stringify({ archiveError: String(archiveError), fallbackError: String(fallbackError), fixtureDirectory: currentFixture.directory })}\n`,
            );
          }
        }
      } else {
        process.stderr.write(
          `[P38_BROWSER_FAILURE_FIXTURE_RETAINED] ${JSON.stringify({ fixtureDirectory: currentFixture.directory, databaseFile: currentFixture.databaseFile, daemonsExited: currentFixture.daemonsExited(), resultDirectory: resultDirectory ?? null })}\n`,
        );
      }
    } else {
      removeFunctionalFixtureDirectory(currentFixture.directory);
    }
  }

  if (stopError !== undefined) {
    throw new Error("P38 browser approval fixture cleanup failed", {
      cause: stopError,
    });
  }
});

interface P38BrowserDiagnosticContext {
  readonly marker: string;
  readonly secretCanary: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly effectLog: string;
  readonly providerRoutes: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly daemonStdout: ReadonlyArray<string>;
  readonly phase?: string;
  readonly approveCommand?: Readonly<Record<string, unknown>>;
}

const readP38BrowserFailureSnapshot = (
  databaseFile: string,
  workspaceDirectory: string,
  context: P38BrowserDiagnosticContext,
): Record<string, unknown> => {
  let db: DatabaseSync | undefined;
  const redactCanary = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.split(context.secretCanary).join("[redacted-canary]");
    if (value instanceof Uint8Array)
      return redactCanary(new TextDecoder().decode(value));
    if (Array.isArray(value)) return value.map(redactCanary);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redactCanary(entry)]),
      );
    return value;
  };
  try {
    db = new DatabaseSync(databaseFile, { readOnly: true });
    db.exec("BEGIN");
    const execution = db
      .prepare(
        `SELECT execution_id, project_id, workspace_id, session_id,
                episode_kind, episode_ref, episode_revision,
                stop_requested_at, settled_at,
                settlement_kind, settlement_json
           FROM executions WHERE execution_id = ? AND project_id = ?`,
      )
      .get(context.executionId, context.projectId) as
      | { readonly session_id: string }
      | undefined;
    const lease = db
      .prepare(
        `SELECT execution_id, worker_id, worker_incarnation_id,
                generation, expires_at, updated_at
           FROM execution_leases WHERE execution_id = ?`,
      )
      .get(context.executionId);
    const approval = db
      .prepare(
        `SELECT approval_id, route_kind, binding_proven, execution_id,
                project_id, workspace_id, state, revision, consumed_at,
                consumed_by, logical_step_no, repair_attempt, action_index,
                logical_action_id, call_ref, tool_invocation_id,
                stable_action_id AS tool_name,
                action_version AS tool_version, action_digest, expires_at
           FROM action_approvals
          WHERE approval_id = ? AND route_kind = 'Executable'`,
      )
      .get(context.approvalId);
    const actionIdentity = approval as
      | {
          readonly execution_id: string;
          readonly logical_step_no: number;
          readonly repair_attempt: number;
          readonly action_index: number;
          readonly logical_action_id: string;
          readonly tool_invocation_id: string;
          readonly call_ref: string;
        }
      | undefined;
    const steps = db
      .prepare(
        `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                revision, next_action_index, settlement_json
           FROM agent_loop_steps WHERE execution_id = ?
          ORDER BY logical_step_no, repair_attempt`,
      )
      .all(context.executionId);
    const action =
      actionIdentity === undefined
        ? undefined
        : db
            .prepare(
              `SELECT logical_step_no, repair_attempt, action_index,
                      logical_action_id, call_ref, route_kind, action_kind,
                      state, result_ref, settlement_ref, disposition_json,
                      observation_source_ref, revision
                 FROM agent_loop_step_actions
                WHERE execution_id = ? AND logical_step_no = ?
                  AND repair_attempt = ? AND action_index = ?
                  AND logical_action_id = ? AND call_ref = ?`,
            )
            .get(
              actionIdentity.execution_id,
              actionIdentity.logical_step_no,
              actionIdentity.repair_attempt,
              actionIdentity.action_index,
              actionIdentity.logical_action_id,
              actionIdentity.call_ref,
            );
    const invocations = db
      .prepare(
        `SELECT invocation_id, tool_name, tool_version, approval_id,
                effect_admission_state, recovery_binding_state,
                recovery_binding_sha256, settled_at, settlement_kind,
                settlement_json, result_ref, observation_json
           FROM tool_invocations WHERE execution_id = ? AND approval_id = ?
          ORDER BY intent_at`,
      )
      .all(context.executionId, context.approvalId) as Array<{
      readonly invocation_id: string;
    }>;
    const recoveryBindings = db
      .prepare(
        `SELECT i.invocation_id, i.recovery_binding_state,
                i.recovery_binding_sha256, b.binding_version,
                b.canonical_binding_json, b.binding_sha256
           FROM tool_invocations i
           LEFT JOIN tool_invocation_recovery_bindings b
             ON b.invocation_id = i.invocation_id
          WHERE i.execution_id = ? AND i.approval_id = ?
          ORDER BY i.intent_at`,
      )
      .all(context.executionId, context.approvalId);
    const attempts = db
      .prepare(
        `SELECT a.invocation_id, a.attempt_no, a.admission_state,
                a.admission_source, a.admission_time_precision,
                a.binding_sha256, a.admitted_at
           FROM tool_invocation_effect_attempts a
           JOIN tool_invocations i ON i.invocation_id = a.invocation_id
          WHERE i.execution_id = ? AND i.approval_id = ?
          ORDER BY a.invocation_id, a.attempt_no`,
      )
      .all(context.executionId, context.approvalId);
    const toolResults =
      execution === undefined
        ? []
        : db
            .prepare(
              `SELECT sequence, source_kind, source_ref, payload_json
                 FROM session_entries
                WHERE session_id = ? AND item_type = 'ToolResult'
                ORDER BY sequence`,
            )
            .all(execution.session_id)
            .flatMap((row) => {
              const entry = row as {
                readonly sequence: number;
                readonly source_kind: string;
                readonly source_ref: string;
                readonly payload_json: string;
              };
              try {
                const payload = JSON.parse(entry.payload_json) as Record<
                  string,
                  unknown
                >;
                if (payload.callRef !== actionIdentity?.call_ref) return [];
                return [
                  {
                    sequence: entry.sequence,
                    sourceKind: entry.source_kind,
                    sourceRef: entry.source_ref,
                    callRef: payload.callRef,
                    payloadTag: payload._tag ?? null,
                  },
                ];
              } catch {
                return [];
              }
            });
    const unavailableFacts = db
      .prepare(
        `SELECT provider_id, provider_version, failure_code,
                probe_evidence_ref, attention_fact_id
           FROM sandbox_provider_unavailable_facts
          WHERE execution_id = ? ORDER BY policy_revision`,
      )
      .all(context.executionId);
    const unavailableQueue = db
      .prepare(
        `SELECT q.attention_fact_id, q.state
           FROM sandbox_provider_unavailable_attention_queue q
           JOIN sandbox_provider_unavailable_facts f
             ON f.attention_fact_id = q.attention_fact_id
            AND f.project_id = q.project_id
          WHERE f.execution_id = ? ORDER BY q.attention_fact_id`,
      )
      .all(context.executionId);
    const inbox = db
      .prepare(
        `SELECT entry_key, consumed_at
           FROM inbox_entries WHERE workspace_id = ? AND entry_key IN (?, ?)
          ORDER BY entry_key`,
      )
      .all(
        context.workspaceId,
        `eap:${context.approvalId}:${context.approvalRevision}`,
        `eap:${context.approvalId}:${context.approvalRevision + 1}`,
      );
    db.exec("COMMIT");

    const effectPath = join(workspaceDirectory, context.effectLog);
    const proofPath = join(workspaceDirectory, "proof.txt");
    const effectText = existsSync(effectPath)
      ? readFileSync(effectPath, "utf8")
      : "";
    const result = {
      publicIdentity: {
        projectId: context.projectId,
        workspaceId: context.workspaceId,
        executionId: context.executionId,
        approvalId: context.approvalId,
        approvalRevision: context.approvalRevision,
        approveCommand: context.approveCommand,
      },
      execution,
      lease,
      approval,
      steps,
      action,
      invocations,
      recoveryBindings,
      attempts,
      toolResults,
      sandboxProviderUnavailableFacts: unavailableFacts,
      sandboxProviderUnavailableQueue: unavailableQueue,
      sandboxPolicyDecisions: db
        .prepare(
          `SELECT policy_revision, policy_digest, profile_id, provider_id,
                  episode_binding_json, decision_command_id, expires_at
             FROM sandbox_policy_decisions WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(context.executionId),
      inbox,
      providerRoutes: context.providerRoutes,
      providerCallCount: context.providerRoutes.length,
      phase: context.phase ?? "post-browser-approval-effect-wait",
      daemonStdoutTail: context.daemonStdout.slice(-100),
      effectFiles: {
        effectLogExists: existsSync(effectPath),
        effectLogBytes: Buffer.byteLength(effectText, "utf8"),
        effectLogLineCount: effectText
          .split(/\r?\n/u)
          .filter((line) => line.length > 0).length,
        effectLogContainsExpectedCanary: effectText.includes(
          context.secretCanary,
        ),
        proofExists: existsSync(proofPath),
      },
    };
    return redactCanary(result) as Record<string, unknown>;
  } catch (error) {
    try {
      if (db?.isTransaction) db.exec("ROLLBACK");
    } catch {
      // Preserve the snapshot failure as the reported diagnostic.
    }
    return {
      snapshotError: error instanceof Error ? error.message : String(error),
      projectId: context.projectId,
      executionId: context.executionId,
      approvalId: context.approvalId,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Keep the original diagnostic result/error primary.
    }
  }
};

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

test("P38 browser approval resumes the same action under explicitly configured TrustedLocal P11 policy", async ({
  page,
}) => {
  const marker = `P38-BROWSER-${crypto.randomUUID().slice(0, 8)}`;
  const secretCanary = `P38-SHELL-CANARY-${crypto.randomUUID()}`;
  const destination = `p38-browser-${marker}.txt`;
  const effectLog = `p38-browser-${marker}.log`;
  const command =
    process.platform === "win32"
      ? `if (Test-Path -LiteralPath 'proof.txt') { Add-Content -LiteralPath '${effectLog}' -Value '${secretCanary}'; mv -LiteralPath 'proof.txt' -Destination '${destination}'; Write-Output '${marker}' }`
      : `if [ -f proof.txt ]; then printf '%s\\n' '${secretCanary}' >> '${effectLog}' && mv proof.txt '${destination}' && printf '%s\\n' '${marker}'; fi`;
  const providerRoutes: Array<Readonly<Record<string, unknown>>> = [];
  const daemonStdout: string[] = [];
  const trustedLocalP11 = createTrustedLocalP11FixtureEnvironment();
  trustedLocalP11.daemonEnvironment.ARBOR_TICK_INTERVAL_MS = "25";
  const trustedLocalPolicyExpiresAt = new Date(
    Date.now() + 60 * 60_000,
  ).toISOString();
  let releaseShellAction!: () => void;
  let markShellActionRequested!: () => void;
  const shellActionGate = new Promise<void>((resolveGate) => {
    releaseShellAction = resolveGate;
  });
  const shellActionRequested = new Promise<void>((resolveRequest) => {
    markShellActionRequested = resolveRequest;
  });
  let diagnosticPhase = "fixture-started";
  let diagnosticContext: P38BrowserDiagnosticContext | undefined;
  let approveCommandEvidence: Readonly<Record<string, unknown>> | undefined;
  fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    preserveDirectoryOnStop: true,
    onDaemonStdout: (line) => daemonStdout.push(line),
    daemonEnvironment: trustedLocalP11.daemonEnvironment,
    setupProbe: trustedLocalP11.setupProbe,
    firstDaemonEntry: resolve(
      "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
    ),
    beforeResponse: async (call) => {
      const names = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (names.has("shell")) {
        markShellActionRequested();
        await shellActionGate;
      }
    },
    reply: (call) => {
      const availableToolNames = call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined);
      const tools = new Set(availableToolNames);
      const context = JSON.stringify(call.messages);
      const rootAssignment =
        tools.has("assign_work") &&
        !tools.has("claim_completion") &&
        context.includes(marker);
      const workspaceShell =
        tools.has("shell") &&
        tools.has("claim_completion") &&
        context.includes(marker);
      const effectReturned = call.messages.some(
        (message) =>
          message.role === "tool" && message.content?.includes(marker),
      );
      const selectedBranch = rootAssignment
        ? context.includes("WorkAssigned(")
          ? "root-work-already-assigned"
          : "root-assign-work"
        : workspaceShell
          ? effectReturned
            ? "workspace-observed-effect"
            : "workspace-shell"
          : "fallback-text";
      providerRoutes.push({
        requestNo: providerRoutes.length + 1,
        availableToolNames,
        markerPresent: context.includes(marker),
        workAssignedLiteralPresent: context.includes("WorkAssigned("),
        effectReturned,
        selectedBranch,
      });
      if (rootAssignment) {
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
      if (workspaceShell) {
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
  preserveFixtureForFailure = true;

  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `P38 browser approval ${marker}`,
    { resourceSelection: "Profile" },
  );
  await initializeTrustedLocalP11Worktree({
    databaseFile: fixture.databaseFile,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    path: fixture.workspaceDirectory,
  });
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
  diagnosticPhase = "waiting-for-trusted-local-shell-provider-request";
  await shellActionRequested;
  const activeWork = await waitForPublic(
    () =>
      client.view<{
        readonly activeExecution?: { readonly executionId: string };
      } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
    (work) => work?.activeExecution?.executionId !== undefined,
  );
  const trustedLocalExecutionId = activeWork?.activeExecution?.executionId;
  if (trustedLocalExecutionId === undefined)
    throw new Error("P38 Work has no active Execution for P1 grant setup");
  diagnosticPhase = "granting-trusted-local-policy-authority";
  await grantTrustedLocalP11Permission({
    client,
    projectId: project.projectId,
    executionId: trustedLocalExecutionId,
    expiresAt: trustedLocalPolicyExpiresAt,
  });
  releaseShellAction();
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
  expect(executableTarget.executionId).toBe(trustedLocalExecutionId);
  diagnosticPhase = "executable-approval-visible";
  diagnosticContext = {
    marker,
    secretCanary,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    executionId: executableTarget.executionId,
    approvalId: executableTarget.approvalId,
    approvalRevision: executableTarget.revision,
    effectLog,
    providerRoutes,
    daemonStdout,
  };
  fixtureFailureEvidence = () => {
    const activeFixture = fixture;
    const context = diagnosticContext;
    if (activeFixture === undefined || context === undefined)
      return { diagnosticContextAvailable: false };
    return readP38BrowserFailureSnapshot(
      activeFixture.databaseFile,
      activeFixture.workspaceDirectory,
      {
        ...context,
        phase: diagnosticPhase,
        ...(approveCommandEvidence === undefined
          ? {}
          : { approveCommand: approveCommandEvidence }),
      },
    );
  };

  // This journey explicitly tests the P38 browser approval surface under a
  // configured TrustedLocal P11 policy. It does not qualify an OS sandbox.
  diagnosticPhase = "committing-trusted-local-p1-policy";
  await commitTrustedLocalP11Policy({
    client,
    baseUrl: fixture.baseUrl,
    databaseFile: fixture.databaseFile,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    executionId: executableTarget.executionId,
    expiresAt: trustedLocalPolicyExpiresAt,
  });
  diagnosticPhase = "trusted-local-p1-policy-committed";
  const beforeBrowserApproval = readP38BrowserFailureSnapshot(
    fixture.databaseFile,
    fixture.workspaceDirectory,
    { ...diagnosticContext, phase: diagnosticPhase },
  );
  expect(beforeBrowserApproval.approval).toMatchObject({
    approval_id: executableTarget.approvalId,
    state: "Pending",
    revision: executableTarget.revision,
  });
  expect(beforeBrowserApproval.invocations).toEqual([]);
  expect(beforeBrowserApproval.sandboxPolicyDecisions).toMatchObject([
    { profile_id: "FullAccess", provider_id: "TrustedLocal" },
  ]);

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
  const approveResponsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return (
      new URL(response.url()).pathname === "/commands" &&
      request.method() === "POST"
    );
  });
  await page.getByLabel("审批决定").selectOption("Approve");
  await page.getByRole("button", { name: "批准并继续" }).click();
  const approveResponse = await approveResponsePromise;
  const approveRequest = approveResponse.request().postDataJSON() as {
    readonly commandType?: string;
    readonly payload?: Record<string, unknown>;
  };
  const approveReceipt = (await approveResponse.json()) as Record<
    string,
    unknown
  >;
  approveCommandEvidence = {
    status: approveResponse.status(),
    commandType: approveRequest.commandType,
    payload: approveRequest.payload,
    receipt: approveReceipt,
  };
  diagnosticPhase = "browser-approved-exact-eap-receipt";
  expect(approveResponse.status()).toBe(200);
  expect(approveRequest).toMatchObject({
    commandType: "ResolveExecutableApproval",
    payload: {
      approvalId: executableTarget.approvalId,
      expectedRevision: executableTarget.revision,
      decision: "Approve",
    },
  });
  expect(approveReceipt).toMatchObject({
    ok: true,
    status: 200,
    body: {
      resolution: "Committed",
      result: {
        approvalId: executableTarget.approvalId,
        executionId: executableTarget.executionId,
        state: "Approved",
        revision: executableTarget.revision + 1,
      },
    },
  });
  await expect(
    page.getByText(/不证明动作已执行、产生效果或工作已完成/u),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看对应工作区详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看对应工作区详情" }).click();
  await expect(page).toHaveURL(
    `${fixture.baseUrl}/p/${project.projectId}/workspace/${project.rootWorkspaceId}`,
  );

  await expect
    .poll(
      () =>
        existsSync(join(fixture?.workspaceDirectory ?? "", effectLog))
          ? requireEffectCount(fixture?.workspaceDirectory ?? "", effectLog)
          : 0,
      { timeout: 45_000 },
    )
    .toBe(1);
  if (diagnosticContext === undefined)
    throw new Error(
      "P38 browser approval diagnostic identity was not captured",
    );
  const completedSnapshot = readP38BrowserFailureSnapshot(
    fixture.databaseFile,
    fixture.workspaceDirectory,
    {
      ...diagnosticContext,
      approveCommand: approveCommandEvidence,
    },
  );
  const completedApproval = completedSnapshot.approval as {
    readonly approval_id: string;
    readonly execution_id: string;
    readonly logical_step_no: number;
    readonly repair_attempt: number;
    readonly action_index: number;
    readonly logical_action_id: string;
    readonly call_ref: string;
    readonly tool_invocation_id: string;
  };
  const completedSteps = completedSnapshot.steps as Array<{
    readonly logical_step_no: number;
    readonly repair_attempt: number;
    readonly provider_turn_id: string;
  }>;
  const completedStep = completedSteps.find(
    (step) =>
      step.logical_step_no === completedApproval.logical_step_no &&
      step.repair_attempt === completedApproval.repair_attempt,
  );
  expect(completedSnapshot.approval).toMatchObject({
    approval_id: executableTarget.approvalId,
    execution_id: executableTarget.executionId,
    state: "Consumed",
    consumed_by: expect.any(String),
  });
  expect(completedSnapshot.action).toMatchObject({
    state: "Applied",
    logical_step_no: completedApproval.logical_step_no,
    repair_attempt: completedApproval.repair_attempt,
    action_index: completedApproval.action_index,
    logical_action_id: completedApproval.logical_action_id,
    call_ref: completedApproval.call_ref,
  });
  expect(completedStep?.provider_turn_id).toMatch(/^ptn_/u);
  expect(completedSnapshot.invocations).toHaveLength(1);
  expect(completedSnapshot.invocations).toMatchObject([
    {
      invocation_id: completedApproval.tool_invocation_id,
      approval_id: executableTarget.approvalId,
      settlement_kind: "Success",
    },
  ]);
  expect(completedSnapshot.recoveryBindings).toHaveLength(1);
  const completedBindingRows = completedSnapshot.recoveryBindings as Array<{
    readonly canonical_binding_json: string | null;
    readonly binding_sha256: string | null;
    readonly recovery_binding_sha256: string | null;
  }>;
  const completedBinding = completedBindingRows[0];
  if (
    completedBinding?.canonical_binding_json === null ||
    completedBinding?.canonical_binding_json === undefined
  )
    throw new Error("P38 browser approval RecoveryBinding was absent");
  expect(JSON.parse(completedBinding.canonical_binding_json)).toMatchObject({
    executionId: executableTarget.executionId,
    invocationId: completedApproval.tool_invocation_id,
    providerTurnId: completedStep?.provider_turn_id,
    logicalStepNo: completedApproval.logical_step_no,
    repairAttempt: completedApproval.repair_attempt,
    logicalActionId: completedApproval.logical_action_id,
    actionIndex: completedApproval.action_index,
    callRef: completedApproval.call_ref,
    approvalId: executableTarget.approvalId,
  });
  expect(completedBinding.binding_sha256).toBe(
    completedBinding.recovery_binding_sha256,
  );
  expect(completedSnapshot.effectFiles).toMatchObject({
    effectLogExists: true,
    effectLogLineCount: 1,
    proofExists: false,
  });
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
