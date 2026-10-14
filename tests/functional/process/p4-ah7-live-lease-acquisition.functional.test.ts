import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

interface LeaseProbe {
  readonly tag: "P4_FENCE_PROBE";
  readonly role: "old" | "new";
  readonly pid: number;
  readonly observedAt: string;
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly workerId?: string;
  readonly workerIncarnationId?: string;
  readonly invocationId?: string;
  readonly source?: string;
  readonly toolName?: string;
  readonly definitionCount?: number;
  readonly definitionsTruncated?: boolean;
  readonly definitions?: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly hash: string;
    readonly sideEffectSemantics?: string;
    readonly source?: string;
  }>;
  readonly matchingRefs?: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly hash: string;
  }>;
}

interface LeaseRow {
  readonly execution_id: string;
  readonly worker_id: string;
  readonly worker_incarnation_id: string;
  readonly generation: number;
  readonly expires_at: string;
}

interface InvocationRow {
  readonly invocation_id: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
}

interface ExecutionRow {
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
}

interface PendingExecutableApprovalRow {
  readonly approval_id: string;
  readonly execution_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly tool_invocation_id: string;
  readonly side_effect_semantics: string;
  readonly state: string;
  readonly revision: number;
  readonly provider_turn_id: string;
  readonly step_state: string;
  readonly action_state: string;
}

const fixtures: ProductionFixture[] = [];
const fenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);
let probeLogFile: string | undefined;
let workExecutionId: string | undefined;
let effectObserved = false;
const schedulerDiagnosticLines: string[] = [];
let probeLogLinesWritten = 0;
const maximumP4DiagnosticLines = 512;
let pendingP4FailureEvidence:
  | {
      readonly fixture: ProductionFixture;
      readonly path: string;
      readonly executionId: string;
      readonly report: Record<string, unknown>;
      readonly daemonSnapshots: () => Readonly<Record<string, unknown>>;
    }
  | undefined;

const appendProbeLine = (line: string) => {
  if (
    probeLogFile === undefined ||
    probeLogLinesWritten >= maximumP4DiagnosticLines
  ) {
    return;
  }
  appendFileSync(probeLogFile, `${line}\n`);
  probeLogLinesWritten += 1;
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.stop();
    } finally {
      const pending = pendingP4FailureEvidence;
      if (pending?.fixture === fixture) {
        const completedEvidence = {
          ...pending.report,
          afterStopExecutionSnapshot: p4FailureSnapshot(
            fixture.databaseFile,
            pending.executionId,
          ),
          afterStopDaemonSnapshots: pending.daemonSnapshots(),
        };
        writeFileSync(
          pending.path,
          JSON.stringify(completedEvidence, null, 2),
          "utf8",
        );
        pendingP4FailureEvidence = undefined;
      }
    }
  }
});

const recordProbe = (events: LeaseProbe[], line: string) => {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.tag === "P4_SCHEDULER_PROBE") {
      if (schedulerDiagnosticLines.length < 64) {
        const safe = JSON.stringify(parsed);
        schedulerDiagnosticLines.push(safe);
        appendProbeLine(safe);
      }
      return;
    }
    const probe = parsed as unknown as LeaseProbe;
    if (probe.tag === "P4_FENCE_PROBE") {
      if (events.length < maximumP4DiagnosticLines) events.push(probe);
      if (
        probe.boundary === "AH7AfterToolEffectBeforeSettlement" &&
        probe.executionId === workExecutionId
      ) {
        effectObserved = true;
      }
      appendProbeLine(JSON.stringify(probe));
    }
  } catch {
    // Keep non-probe daemon output in ProductionFixture diagnostics.
  }
};

const executionRows = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      lease: db
        .prepare(
          "SELECT execution_id, worker_id, worker_incarnation_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as LeaseRow | undefined,
      invocations: db
        .prepare(
          "SELECT invocation_id, settled_at, settlement_kind FROM tool_invocations WHERE execution_id = ? ORDER BY intent_at",
        )
        .all(executionId) as unknown as InvocationRow[],
      execution: db
        .prepare(
          "SELECT settled_at, settlement_kind FROM executions WHERE execution_id = ?",
        )
        .get(executionId) as ExecutionRow | undefined,
      providerTurnCount: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS turn_count FROM provider_turns WHERE execution_id = ?",
            )
            .get(executionId) as { readonly turn_count: number } | undefined
        )?.turn_count ?? 0,
      ),
      providerAttempts: db
        .prepare(
          `SELECT pt.provider_turn_id, pa.attempt_no, pa.outcome
             FROM provider_turns pt
             JOIN provider_attempts pa USING (provider_turn_id)
            WHERE pt.execution_id = ?
            ORDER BY pt.started_at, pa.attempt_no`,
        )
        .all(executionId) as Array<{
        readonly provider_turn_id: string;
        readonly attempt_no: number;
        readonly outcome: string;
      }>,
    };
  } finally {
    db.close();
  }
};

const p4FailureSnapshot = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      execution: db
        .prepare(
          `SELECT execution_id, workspace_id, binding_kind, episode_kind,
                  episode_ref, episode_revision, settled_at, settlement_kind
             FROM executions WHERE execution_id = ?`,
        )
        .get(executionId),
      workspace: db
        .prepare(
          `SELECT workspace_id, lifecycle, current_work_id, revision
             FROM workspaces
            WHERE workspace_id = (
              SELECT workspace_id FROM executions WHERE execution_id = ?
            )`,
        )
        .get(executionId),
      work: db
        .prepare(
          `SELECT work_id, workspace_id, lifecycle, revision
             FROM works
            WHERE work_id = (
              SELECT episode_ref FROM executions
               WHERE execution_id = ? AND episode_kind = 'WorkEpisode'
            )`,
        )
        .get(executionId),
      lease: db
        .prepare(
          `SELECT execution_id, worker_id, worker_incarnation_id, generation,
                  expires_at FROM execution_leases WHERE execution_id = ?`,
        )
        .get(executionId),
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  next_action_index, revision, updated_at
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId),
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, route_kind, action_kind,
                  input_hash, state, observation_source_ref, revision, updated_at
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId),
      invocations: db
        .prepare(
          `SELECT invocation_id, tool_name, tool_version, side_effect_semantics,
                  arguments_json, resolved_regions_json, approval_id,
                  effect_admission_state, intent_at, settled_at,
                  settlement_kind, settlement_json, result_ref
             FROM tool_invocations WHERE execution_id = ? ORDER BY intent_at`,
        )
        .all(executionId),
      providerAttempts: db
        .prepare(
          `SELECT pt.provider_turn_id, pa.attempt_no, pa.outcome,
                  pa.provider_error_kind, pa.settled_at
             FROM provider_turns pt
             JOIN provider_attempts pa USING (provider_turn_id)
            WHERE pt.execution_id = ?
            ORDER BY pt.started_at, pa.attempt_no`,
        )
        .all(executionId),
      providerTurns: db
        .prepare(
          `SELECT provider_turn_id, started_at, settled_at, finish_reason
             FROM provider_turns WHERE execution_id = ? ORDER BY started_at`,
        )
        .all(executionId),
      sessionTimeline: db
        .prepare(
          `SELECT se.sequence, se.item_type, se.source_kind, se.source_ref,
                  se.payload_json, se.content_hash, se.created_at
             FROM session_entries se
             JOIN executions e ON e.session_id = se.session_id
            WHERE e.execution_id = ?
            ORDER BY se.sequence`,
        )
        .all(executionId),
      executableApprovals: db
        .prepare(
          `SELECT approval_id, route_kind, project_id, workspace_id,
                  execution_id, subject_ref, stable_action_id, action_version,
                  side_effect_semantics, action_digest, arguments_json,
                  target_ref, target_resource_space_ids_json,
                  control_basis_digest, state, revision, requested_at,
                  expires_at, decided_at, decided_by, decision_reason,
                  consumed_at, consumed_by, binding_proven, source_state,
                  logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, tool_invocation_id,
                  cancelled_at, cancelled_by, cancellation_reason
             FROM action_approvals
            WHERE execution_id = ? AND route_kind = 'Executable'
            ORDER BY requested_at`,
        )
        .all(executionId),
      projectToolRegistryRows: db
        .prepare(
          `SELECT project_id, plugin_id, plugin_version, content_hash,
                  definitions_json, registered_at
             FROM project_tool_registry
            WHERE project_id = (
              SELECT project_id FROM executions WHERE execution_id = ?
            )
            ORDER BY registered_at, plugin_id, plugin_version, content_hash`,
        )
        .all(executionId),
    };
  } finally {
    db.close();
  }
};

const deriveCatalogSnapshot = (
  executionSnapshot: ReturnType<typeof p4FailureSnapshot>,
  builtinCatalog: LeaseProbe | undefined,
) => {
  type CatalogDefinition = {
    readonly name: string;
    readonly version: string;
    readonly hash: string;
    readonly sideEffectSemantics?: string;
    readonly source?: string;
  };
  const builtinDefinitions = builtinCatalog?.definitions ?? [];
  const registeredDefinitions = (
    executionSnapshot.projectToolRegistryRows as Array<{
      readonly definitions_json: string;
    }>
  ).flatMap(
    (row) => JSON.parse(row.definitions_json) as Array<CatalogDefinition>,
  );
  const visibleRefs = [...builtinDefinitions, ...registeredDefinitions].map(
    ({ name, version, hash }) => ({ name, version, hash }),
  );
  return {
    source: "BUILTIN_TOOLS plus project_tool_registry definitions_json",
    visibleRefCount: visibleRefs.length,
    visibleRefs: visibleRefs.slice(0, 32),
    visibleRefsTruncated: visibleRefs.length > 32,
  };
};

const pendingExecutableApproval = (
  databaseFile: string,
  approvalId: string,
): PendingExecutableApprovalRow | undefined => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT ap.approval_id, ap.execution_id, ap.logical_step_no,
                ap.repair_attempt,
                ap.action_index, ap.logical_action_id, ap.call_ref,
                ap.tool_invocation_id, ap.side_effect_semantics, ap.state,
                ap.revision, s.provider_turn_id, s.state AS step_state,
                a.state AS action_state
           FROM action_approvals ap
           JOIN agent_loop_steps s
             ON s.execution_id = ap.execution_id
            AND s.logical_step_no = ap.logical_step_no
            AND s.repair_attempt = ap.repair_attempt
           JOIN agent_loop_step_actions a
             ON a.execution_id = ap.execution_id
            AND a.logical_step_no = ap.logical_step_no
            AND a.repair_attempt = ap.repair_attempt
            AND a.action_index = ap.action_index
            AND a.logical_action_id = ap.logical_action_id
          WHERE ap.approval_id = ? AND ap.route_kind = 'Executable'
            AND ap.binding_proven = 1`,
      )
      .get(approvalId) as PendingExecutableApprovalRow | undefined;
  } finally {
    db.close();
  }
};

describe("P4 lease acquisition while another daemon owns a live lease", () => {
  it("records a real rejected acquisition for the same active Execution", async () => {
    const marker = `P4-LIVE-${crypto.randomUUID().slice(0, 8)}`;
    const steerMarker = `P4-LIVE-STEER-${crypto.randomUUID().slice(0, 8)}`;
    const effectMarker = `P4_LIVE_EFFECT_${marker}`;
    const effectFile = `p4-live-${marker}.txt`;
    const command =
      process.platform === "win32"
        ? `Add-Content -LiteralPath '${effectFile}' -Value '${effectMarker}'`
        : `printf '%s\\n' '${effectMarker}' >> '${effectFile}'`;
    const events: LeaseProbe[] = [];
    const providerTimeline: Array<{
      readonly event: string;
      readonly at: string;
      readonly callIndex?: number;
    }> = [];
    const startupDiagnostics: Array<{
      readonly stage: "after-clone" | "provider-started";
      readonly directory: string;
      readonly providerPort?: number;
    }> = [];
    const leaseExpiryHistory: Array<{
      readonly observedAt: string;
      readonly generation: number;
      readonly expiresAt: string;
    }> = [];
    let manualWaitCalls = 0;
    let targetToolCalls = 0;

    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      preserveDirectoryOnStop: true,
      firstDaemonEntry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
      },
      setupProbe: (event) => {
        if (startupDiagnostics.length < 8) startupDiagnostics.push(event);
      },
      onDaemonStdout: (line) => recordProbe(events, line),
      onResponseSent: (call, callIndex) => {
        const context = JSON.stringify(call.messages);
        if (context.includes(marker) && context.includes(steerMarker)) {
          providerTimeline.push({
            event: "server-response-sent",
            at: new Date().toISOString(),
            callIndex,
          });
        }
      },
      reply: (call) => {
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        const context = JSON.stringify(call.messages);
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Wait for a steer, then append ${effectMarker} once with shell.`,
                  why: "qualify live lease admission across daemon processes",
                  constraints: [],
                  completionExpectation: "one shell effect is recorded",
                  verificationMission: {
                    goal: `Verify the one-time effect ${marker}`,
                    criteria: [
                      {
                        criterionId: "one-effect",
                        requirement: `${effectFile} contains ${effectMarker} once`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "P4 live lease acquisition qualification",
                },
              };
        }
        if (
          available.has("claim_completion") &&
          available.has("shell") &&
          context.includes(marker)
        ) {
          if (!context.includes(steerMarker)) {
            manualWaitCalls += 1;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `wait for ${steerMarker}`,
                waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
              },
            };
          }
          if (effectObserved) {
            return {
              _tag: "ToolCall",
              name: "claim_completion",
              arguments: {
                claim: `The one-time effect ${marker} is present.`,
              },
            };
          }
          targetToolCalls += 1;
          if (targetToolCalls === 1) {
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
          return { _tag: "Text", text: `Finished ${marker}` };
        }
        return { _tag: "Text", text: `Waiting for ${marker}` };
      },
    }).catch((error: unknown) => {
      const resultDirectory = resolve(".test-results");
      mkdirSync(resultDirectory, { recursive: true });
      const failure = error instanceof Error ? error.message : String(error);
      writeFileSync(
        join(resultDirectory, "p4-live-lease-startup-failure.json"),
        JSON.stringify(
          {
            failure,
            startupDiagnostics,
            daemonStdoutProbes: events.slice(0, maximumP4DiagnosticLines),
          },
          null,
          2,
        ),
        "utf8",
      );
      throw error;
    });
    fixtures.push(fixture);
    probeLogFile = join(fixture.directory, "p4-live-lease-probes.ndjson");

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "P4 live lease acquisition",
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
      `请创建一个等待人工指示后执行一次shell写入的Work，目标标记 ${marker}。`,
    );
    const workApproval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: workApproval.approvalId,
      expectedRevision: workApproval.revision,
      decision: "Approve",
      reason: "P4 live lease acquisition qualification",
    });

    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          objective?: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value?.workId !== undefined &&
        value.objective?.includes(marker) === true,
    );
    if (currentWork?.workId === undefined) {
      throw new Error("P4 live-lease Work was not publicly admitted");
    }
    await waitForPublic(
      async () => ({ manualWaitCalls }),
      (value) => value.manualWaitCalls > 0,
    );
    const idleWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value !== null &&
        value.workId === currentWork.workId &&
        value.activeExecution === undefined,
    );
    if (idleWork?.workId === undefined) {
      throw new Error("P4 live-lease Work did not reach its Manual wait");
    }
    await client.command(project.projectId, "SteerWork", {
      workId: idleWork.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: idleWork.revision,
      steer: { severity: "Normal", guidance: `Proceed with ${steerMarker}.` },
      provenance: { source: "HumanInput" },
    });

    const inbox = await waitForPublic(
      () =>
        client.view<{
          unconsumed: Array<{
            entryKey: string;
            kind: string;
            summary: string;
          }>;
        }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value.unconsumed.some(
          (entry) =>
            entry.kind === "Governance" &&
            /^eap:(.+):(\d+)$/u.test(entry.entryKey),
        ),
    );
    const approvalEntry = inbox.unconsumed.find(
      (entry) =>
        entry.kind === "Governance" && /^eap:(.+):(\d+)$/u.test(entry.entryKey),
    );
    const approvalMatch =
      approvalEntry === undefined
        ? null
        : /^eap:(.+):(\d+)$/u.exec(approvalEntry.entryKey);
    if (
      approvalMatch === null ||
      approvalMatch[1] === undefined ||
      approvalMatch[2] === undefined
    ) {
      throw new Error(
        `P4 public Inbox exposed no exact pending Executable approval for ${marker}`,
      );
    }
    const approvalId = approvalMatch[1];
    const approvalRevision = Number(approvalMatch[2]);
    const approval = pendingExecutableApproval(
      fixture.databaseFile,
      approvalId,
    );
    if (approval === undefined) {
      throw new Error(`P4 approval ${approvalId} has no proven exact binding`);
    }
    const executionId = approval.execution_id;
    workExecutionId = executionId;
    expect(approval).toMatchObject({
      approval_id: approvalId,
      execution_id: executionId,
      state: "Pending",
      revision: approvalRevision,
      side_effect_semantics: "NonIdempotent",
      step_state: "ActionsInProgress",
      action_state: "Pending",
    });
    expect(
      executionRows(fixture.databaseFile, executionId).invocations,
    ).toEqual([]);

    const approvalResolveStartedAt = Date.now();
    const resolution = await client.command(
      project.projectId,
      "ResolveExecutableApproval",
      {
        approvalId,
        expectedRevision: approvalRevision,
        decision: "Approve",
        reason: "P4 live lease acquisition qualification",
      },
    );
    expect(resolution).toMatchObject({ body: { resolution: "Committed" } });
    const oldAcquired = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === executionId &&
            Date.parse(event.observedAt) >= approvalResolveStartedAt,
        ),
      (event) => event !== undefined,
    ).catch((error: unknown) => {
      const failure = error instanceof Error ? error.message : String(error);
      const evidenceDirectory = resolve(".test-results");
      mkdirSync(evidenceDirectory, { recursive: true });
      const evidencePath = join(
        evidenceDirectory,
        "p4-live-lease-approval-resume-failure.json",
      );
      const executionSnapshot = p4FailureSnapshot(
        fixture.databaseFile,
        executionId,
      );
      const builtinCatalog = events.find(
        (event) => event.boundary === "P4BuiltinCatalogSnapshot",
      );
      writeFileSync(
        evidencePath,
        JSON.stringify(
          {
            failure,
            approvalResolveStartedAt: new Date(
              approvalResolveStartedAt,
            ).toISOString(),
            publicApproval: {
              approvalId,
              expectedRevision: approvalRevision,
              resolution,
              binding: approval,
            },
            currentLease: executionRows(fixture.databaseFile, executionId)
              .lease,
            executionSnapshot,
            derivedCatalog: deriveCatalogSnapshot(
              executionSnapshot,
              builtinCatalog,
            ),
            shellDefinition: events.find(
              (event) => event.boundary === "P4ShellDefinitionSnapshot",
            ),
            builtinCatalog,
            catalogProbes: events.filter(
              (event) => event.boundary === "P4ExecutableCatalogRefs",
            ),
            probeEvents: events.slice(0, maximumP4DiagnosticLines),
            providerTimeline,
            oldDaemon: fixture.daemonProcessSnapshot(),
            daemonErrors: fixture.daemonErrors,
          },
          null,
          2,
        ),
        "utf8",
      );
      throw new Error(
        `Old daemon did not expose a lease reacquisition after executable approval request began; failureEvidence=${evidencePath}`,
        { cause: error },
      );
    });
    if (oldAcquired === undefined) {
      throw new Error(
        "Old daemon did not reacquire the approved Execution after public resolution",
      );
    }

    const effectEvent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolEffectBeforeSettlement" &&
            event.executionId === executionId,
        ),
      (event) => event !== undefined,
      60_000,
    ).catch((error: unknown) => {
      const failure = error instanceof Error ? error.message : String(error);
      const evidenceDirectory = resolve(".test-results");
      mkdirSync(evidenceDirectory, { recursive: true });
      const evidencePath = join(
        evidenceDirectory,
        `p4-live-lease-failure-${executionId}.json`,
      );
      const executionSnapshot = p4FailureSnapshot(
        fixture.databaseFile,
        executionId,
      );
      const builtinCatalog = events.find(
        (event) => event.boundary === "P4BuiltinCatalogSnapshot",
      );
      const evidence = {
        failure,
        fixtureDirectory: fixture.directory,
        databaseFile: fixture.databaseFile,
        targetExecutionId: executionId,
        publicApproval: {
          eapEntryKey: approvalEntry?.entryKey ?? null,
          approvalId,
          expectedRevision: approvalRevision,
          resolution,
          binding: approval,
        },
        oldAcquired,
        currentLease: executionRows(fixture.databaseFile, executionId).lease,
        executionSnapshot,
        derivedCatalog: deriveCatalogSnapshot(
          executionSnapshot,
          builtinCatalog,
        ),
        shellDefinition: events.find(
          (event) => event.boundary === "P4ShellDefinitionSnapshot",
        ),
        builtinCatalog,
        projectToolRegistryRows: executionSnapshot.projectToolRegistryRows,
        catalogRefs: events.filter(
          (event) => event.boundary === "P4ExecutableCatalogRefs",
        ),
        toolRuntimeProgress: events.filter(
          (event) =>
            event.role === "old" &&
            (event.boundary.startsWith("AH7") ||
              event.boundary === "P4ExecutableCatalogRefs" ||
              event.boundary === "P4ExecutableToolRuntimeOutcome" ||
              event.boundary === "P4P39BindClaimBranch" ||
              event.boundary === "AH10AfterLeaseAcquired"),
        ),
        probeEvents: events,
        schedulerDiagnostics: schedulerDiagnosticLines.map((line) =>
          JSON.parse(line),
        ),
        providerTimeline,
        providerCalls: fixture.providerCalls.map((call, callIndex) => ({
          callIndex,
          messages: call.messages,
          availableTools: call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        })),
        oldDaemon: fixture.daemonProcessSnapshot(),
        daemonErrors: fixture.daemonErrors,
      };
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
      pendingP4FailureEvidence = {
        fixture,
        path: evidencePath,
        executionId,
        report: evidence,
        daemonSnapshots: () => ({ old: fixture.daemonProcessSnapshot() }),
      };
      throw new Error(
        `P4 old effect gate timeout; failure=${failure}; approval=${JSON.stringify({ approvalId, approvalRevision, state: approval.state, consumedBy: executionSnapshot.executableApprovals })}; currentLease=${JSON.stringify(evidence.currentLease)}; action=${JSON.stringify(executionSnapshot.actions)}; invocations=${JSON.stringify(executionSnapshot.invocations)}; toolRuntimeProgress=${JSON.stringify(evidence.toolRuntimeProgress)}; failureEvidence=${evidencePath}`,
        { cause: error },
      );
    });
    if (effectEvent === undefined) {
      throw new Error(
        `Old daemon did not reach the after-effect gate; p4=${JSON.stringify(p4FailureSnapshot(fixture.databaseFile, executionId))}`,
      );
    }
    const beforeRetry = executionRows(fixture.databaseFile, executionId).lease;
    expect(beforeRetry).toMatchObject({
      execution_id: executionId,
      generation: oldAcquired.fencingGeneration,
    });
    expect(
      Date.parse(beforeRetry?.expires_at ?? "1970-01-01T00:00:00.000Z"),
    ).toBeGreaterThan(Date.now());
    const initialLeaseExpiry = beforeRetry?.expires_at;
    if (initialLeaseExpiry === undefined) {
      throw new Error("P4 target lease was absent at the old effect gate");
    }
    leaseExpiryHistory.push({
      observedAt: new Date().toISOString(),
      generation: Number(
        oldAcquired.fencingGeneration ?? beforeRetry?.generation,
      ),
      expiresAt: initialLeaseExpiry,
    });
    const effectLines = readFileSync(
      `${fixture.workspaceDirectory}/${effectFile}`,
      "utf8",
    )
      .split(/\r?\n/u)
      .filter((line) => line === effectMarker);
    expect(effectLines).toHaveLength(1);
    expect(
      executionRows(fixture.databaseFile, executionId).invocations,
    ).toEqual([
      expect.objectContaining({
        invocation_id: effectEvent.invocationId,
        settled_at: null,
        settlement_kind: null,
      }),
    ]);

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "new",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        ARBOR_P4_FENCE_EXPLICIT_EXECUTION_ID: executionId,
        ARBOR_P4_FENCE_TARGET_WORKSPACE_ID: project.rootWorkspaceId,
        ARBOR_P4_FENCE_TARGET_WORK_ID: currentWork.workId,
        ARBOR_P4_SCHEDULER_DIAGNOSTICS: "1",
      },
      onStdout: (line) => recordProbe(events, line),
    });
    const schedulerSkip = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10PreDispatchSkippedLiveLease" &&
            event.executionId === executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(schedulerSkip?.pid).not.toBe(oldAcquired.pid);
    expect(
      fixture.providerCalls.filter((call) =>
        JSON.stringify(call.messages).includes(steerMarker),
      ),
    ).toHaveLength(1);
    expect(
      executionRows(fixture.databaseFile, executionId).invocations,
    ).toEqual([
      expect.objectContaining({
        invocation_id: effectEvent.invocationId,
        settled_at: null,
        settlement_kind: null,
      }),
    ]);
    const gateDirectory = join(fixture.directory, "p4-fence-gates");
    mkdirSync(gateDirectory, { recursive: true });
    writeFileSync(
      join(gateDirectory, "new-explicit-runExecution.release"),
      "invoke the production runExecution path for the exact active Execution",
    );
    const rejectedAttempt = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10LeaseAcquisitionRejected" &&
            event.executionId === executionId &&
            event.source === "test-runExecution",
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(rejectedAttempt).toMatchObject({
      executionId,
      fencingGeneration: oldAcquired.fencingGeneration,
      workerId: beforeRetry?.worker_id,
      workerIncarnationId: beforeRetry?.worker_incarnation_id,
    });
    expect(rejectedAttempt?.pid).not.toBe(oldAcquired.pid);
    expect(
      fixture.providerCalls.filter((call) =>
        JSON.stringify(call.messages).includes(steerMarker),
      ),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10AfterLeaseAcquired" &&
          event.executionId === executionId,
      ),
    ).toBe(false);
    const afterRejectedAcquire = executionRows(
      fixture.databaseFile,
      executionId,
    );
    expect(afterRejectedAcquire.lease).toMatchObject({
      worker_id: beforeRetry?.worker_id,
      worker_incarnation_id: beforeRetry?.worker_incarnation_id,
      generation: oldAcquired.fencingGeneration,
    });
    expect(afterRejectedAcquire.invocations).toEqual([
      expect.objectContaining({
        invocation_id: effectEvent.invocationId,
        settled_at: null,
        settlement_kind: null,
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.role === "new" &&
          event.boundary === "AH10ExplicitRunExecutionError" &&
          event.executionId === executionId,
      ),
    ).toBe(false);

    expect(
      executionRows(fixture.databaseFile, executionId).lease?.generation,
    ).toBe(oldAcquired.fencingGeneration);
    expect(
      readFileSync(`${fixture.workspaceDirectory}/${effectFile}`, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    writeFileSync(
      join(gateDirectory, "old-tool-effect.release"),
      "allow the old owner to settle the observed tool effect",
    );

    const settled = await waitForPublic(
      async () => executionRows(fixture.databaseFile, executionId),
      (rows) =>
        rows.invocations.length === 1 &&
        rows.invocations[0]?.settled_at !== null &&
        rows.execution?.settled_at !== null,
      45_000,
    );
    expect(settled.invocations).toHaveLength(1);
    expect(settled.invocations[0]).toMatchObject({
      invocation_id: effectEvent?.invocationId,
      settlement_kind: "Success",
    });
    expect(settled.execution?.settled_at).not.toBeNull();
    expect(settled.lease?.generation).toBe(oldAcquired.fencingGeneration);
    expect(settled.providerTurnCount).toBe(2);
    expect(settled.providerAttempts).toHaveLength(2);
    expect(
      new Set(
        settled.providerAttempts.map((attempt) => attempt.provider_turn_id),
      ).size,
    ).toBe(settled.providerAttempts.length);
    expect(
      settled.providerAttempts.every(
        (attempt) => attempt.attempt_no === 0 && attempt.outcome === "Success",
      ),
    ).toBe(true);
    expect(
      readFileSync(`${fixture.workspaceDirectory}/${effectFile}`, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
    expect(newDaemon.daemonErrors).toEqual([]);
    const resultDirectory = resolve(".test-results");
    mkdirSync(resultDirectory, { recursive: true });
    writeFileSync(
      join(resultDirectory, `p4-live-lease-observation-${executionId}.json`),
      JSON.stringify(
        {
          targetExecutionId: executionId,
          oldAcquired,
          schedulerSkip,
          rejectedAttempt,
          providerTimeline,
          leaseExpiryHistory,
          settledExecution: settled.execution,
          settledInvocations: settled.invocations,
          oldEffectObserved: readFileSync(
            `${fixture.workspaceDirectory}/${effectFile}`,
            "utf8",
          )
            .split(/\r?\n/u)
            .filter((line) => line === effectMarker).length,
          oldDaemon: fixture.daemonProcessSnapshot(),
          newDaemon: newDaemon.daemonProcessSnapshot(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }, 180_000);
});
