import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { p39WindowsTestEnvironment } from "../../support/p39-windows-deployment-test.js";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../support/fixture-failure-evidence.js";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../support/lease-qualification.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

type ActionKind = "propose_workspace" | "update_plan" | "claim_completion";
type Boundary =
  | "AH7AfterActionIntentCommit"
  | "AH7BeforeActionResultCommit"
  | "AH7AfterActionResultCommit"
  | "AH9BeforeTerminalActionCommit"
  | "AH9AfterTerminalActionCommit";

interface Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly routeKind?: "Control" | "Executable";
  readonly actionIndex?: number;
  readonly callRef?: string;
  readonly controlEffectGate?: boolean;
  readonly staleEffectSuppressed?: boolean;
  readonly stage?: string;
}

const fixtures: ProductionFixture[] = [];
const childEntry = resolve("tests/functional/support/ah10-process-child.mjs");
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: { mode: "Any", conditions: [{ _tag: "Manual" }], reason },
});

const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  name: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${name}.release`),
    "release",
  );
};

const waitForActionIntent = async (input: {
  readonly fixture: ProductionFixture;
  readonly events: ReadonlyArray<Probe>;
  readonly role: "old" | "new";
  readonly action: ActionKind;
  readonly executionId?: string;
  readonly logicalActionId?: string;
}): Promise<Probe> => {
  const intent = await waitForPublic(
    async () =>
      input.events.find(
        (event) =>
          event.role === input.role &&
          event.boundary === "AH7AfterActionIntentCommit" &&
          event.actionKind === input.action &&
          (input.executionId === undefined ||
            event.executionId === input.executionId) &&
          (input.logicalActionId === undefined ||
            event.logicalActionId === input.logicalActionId),
      ),
    (event) => event !== undefined,
    45_000,
  );
  expect(intent).toMatchObject({
    executionId: input.executionId ?? expect.any(String),
    providerTurnId: expect.any(String),
    logicalActionId: input.logicalActionId ?? expect.any(String),
    callRef: expect.any(String),
  });
  return intent as Probe;
};

const readLiveTakeoverFailureSnapshot = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly parentWorkspaceId: string;
}) => {
  const db = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = {
      projectId: input.projectId,
      workspaceId: input.parentWorkspaceId,
      workId: input.workId,
      executionId: input.executionId,
      execution: db
        .prepare(
          `SELECT execution_id, project_id, workspace_id, episode_kind,
                  episode_ref, stop_requested_at, settled_at, settlement_kind,
                  settlement_json
             FROM executions
            WHERE project_id = ? AND execution_id = ?`,
        )
        .get(input.projectId, input.executionId),
      lease: db
        .prepare(
          `SELECT execution_id, worker_id, worker_incarnation_id, generation,
                  expires_at, updated_at
             FROM execution_leases WHERE execution_id = ?`,
        )
        .get(input.executionId),
      executionState: db
        .prepare(
          `SELECT episode_json, wake_reason, current_mode, turn_no, updated_at
             FROM agent_execution_state WHERE execution_id = ?`,
        )
        .get(input.executionId),
      steps: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt,
                  provider_turn_id, manifest_id, state, revision,
                  next_action_index, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(input.executionId),
      actions: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt,
                  action_index, logical_action_id, call_ref, action_kind,
                  state, result_ref, settlement_ref, disposition_json
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(input.executionId),
      providerTurns: db
        .prepare(
          `SELECT provider_turn_id, execution_id, session_id, manifest_id,
                  settled_at, finish_reason
             FROM provider_turns WHERE execution_id = ?
            ORDER BY provider_turn_id`,
        )
        .all(input.executionId),
      attempts: db
        .prepare(
          `SELECT a.provider_turn_id, a.attempt_no, a.outcome, a.settled_at,
                  a.success_evidence_version
             FROM provider_attempts a JOIN provider_turns p
               ON p.provider_turn_id = a.provider_turn_id
            WHERE p.execution_id = ? ORDER BY a.provider_turn_id, a.attempt_no`,
        )
        .all(input.executionId),
      workspace: db
        .prepare(
          `SELECT workspace_id, project_id, parent_workspace_id,
                  current_work_id, revision
             FROM workspaces WHERE workspace_id = ? AND project_id = ?`,
        )
        .get(input.parentWorkspaceId, input.projectId),
      work: db
        .prepare(
          `SELECT work_id, workspace_id, objective, lifecycle, revision
             FROM works WHERE work_id = ? AND workspace_id = ?`,
        )
        .get(input.workId, input.parentWorkspaceId),
      plan: db
        .prepare(
          `SELECT work_id, target_work_revision, plan_revision, items_json,
                  updated_at FROM work_plans WHERE work_id = ?`,
        )
        .get(input.workId),
      wait: db
        .prepare(
          `SELECT work_id, wait_mode, conditions_json, registered_at, updated_at
             FROM work_waits WHERE work_id = ?`,
        )
        .get(input.workId),
      projectEvents: db
        .prepare(
          `SELECT event_id, sequence, event_type, aggregate_ref, payload_json,
                  occurred_at FROM domain_events
            WHERE project_id = ? ORDER BY sequence`,
        )
        .all(input.projectId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original diagnostic snapshot error.
    }
    throw error;
  } finally {
    db.close();
  }
};

const captureGen1TakeoverWaitFailure = async (input: {
  readonly fixture: ProductionFixture;
  readonly newDaemon: Awaited<
    ReturnType<ProductionFixture["startAdditionalDaemon"]>
  >;
  readonly events: ReadonlyArray<Probe>;
  readonly action: "update_plan" | "claim_completion";
  readonly marker: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workId: string;
  readonly oldIntent: Probe;
  readonly oldLease: ReturnType<typeof expireLiveOwnerLeaseForStaleProbe>;
  readonly targetCalls: number;
  readonly armed: boolean;
  readonly seedWaitIssued: boolean;
  readonly startupPhases: ReadonlyArray<
    Readonly<Record<string, string | number>>
  >;
  readonly oldStartupPhases: ReadonlyArray<
    Readonly<Record<string, string | number>>
  >;
  readonly providerCalls: ProductionFixture["providerCalls"];
  readonly gateFiles: ReadonlyArray<string>;
  readonly waitError: unknown;
}): Promise<never> => {
  let snapshot: unknown;
  let snapshotError: string | undefined;
  try {
    snapshot = readLiveTakeoverFailureSnapshot({
      databaseFile: input.fixture.databaseFile,
      projectId: input.projectId,
      executionId: input.oldIntent.executionId,
      workId: input.workId,
      parentWorkspaceId: input.workspaceId,
    });
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
  }
  const evidence = {
    testCase: "P9 direct Control effect process takeover",
    action: input.action,
    marker: input.marker,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    workId: input.workId,
    executionId: input.oldIntent.executionId,
    logicalActionId: input.oldIntent.logicalActionId ?? null,
    providerTurnId: input.oldIntent.providerTurnId ?? null,
    callRef: input.oldIntent.callRef ?? null,
    actionIndex: input.oldIntent.actionIndex ?? null,
    oldLeaseBeforeExpiry: input.oldLease,
    testState: {
      armed: input.armed,
      seedWaitIssued: input.seedWaitIssued,
      targetCalls: input.targetCalls,
      gateFiles: input.gateFiles,
    },
    waitError:
      input.waitError instanceof Error
        ? input.waitError.message
        : String(input.waitError),
    processes: {
      oldGen0: input.fixture.daemonProcessSnapshot(),
      newGen1: input.newDaemon.daemonProcessSnapshot(),
      newGen1StderrTail: input.newDaemon.daemonErrors.slice(-24),
      fixtureStderrTail: input.fixture.daemonErrors.slice(-24),
    },
    startupPhases: {
      oldGen0: input.oldStartupPhases,
      newGen1: input.startupPhases,
    },
    probeTail: input.events.slice(-80),
    providerCalls: input.providerCalls.slice(-12).map((call) => ({
      toolNames: call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined)
        .sort(),
      mentionsMarker: JSON.stringify(call.messages).includes(input.marker),
    })),
    snapshot: snapshot ?? null,
    snapshotError: snapshotError ?? null,
  };

  let stopError: string | undefined;
  try {
    await input.fixture.stop();
  } catch (error) {
    stopError = error instanceof Error ? error.message : String(error);
  }

  const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
  let artifactPath: string | undefined;
  let archiveError: string | undefined;
  if (resultDirectory === undefined || resultDirectory.length === 0) {
    archiveError = "ARBOR_TEST_RESULT_DIRECTORY is unset";
  } else {
    try {
      artifactPath = archiveProductionFixtureFailure({
        fixture: input.fixture,
        resultDirectory,
        artifactPrefix: "p9-direct-control-gen1-lease-timeout",
        evidence: { ...evidence, stopError: stopError ?? null },
      });
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
      try {
        writeProductionFixtureArchiveSkipped({
          fixture: input.fixture,
          resultDirectory,
          evidence: { ...evidence, stopError: stopError ?? null, archiveError },
        });
      } catch (skipError) {
        archiveError = `${archiveError}; archive-skip record: ${skipError instanceof Error ? skipError.message : String(skipError)}`;
      }
    }
  }

  throw new Error(
    `gen1 did not emit AH10AfterLeaseAcquired for ${input.action}; project=${input.projectId}; execution=${input.oldIntent.executionId}; action=${input.oldIntent.logicalActionId ?? "unknown"}; artifact=${artifactPath ?? "archive skipped"}; archiveError=${archiveError ?? "none"}; waitError=${input.waitError instanceof Error ? input.waitError.message : String(input.waitError)}`,
    { cause: input.waitError },
  );
};

const qualifiesLiveStaleGenerationSuppression = (
  action: "update_plan" | "claim_completion",
) =>
  it(`${action} suppresses a live stale gen0 effect after gen1 commits the same action`, async () => {
    const marker = `P9-stale-${action}-${crypto.randomUUID().slice(0, 7)}`;
    const events: Probe[] = [];
    const oldStartupPhases: Array<Readonly<Record<string, string | number>>> =
      [];
    const newStartupPhases: Array<Readonly<Record<string, string | number>>> =
      [];
    const targetCalls = { count: 0 };
    let armed = false;
    let seedWaitIssued = false;
    const captureProbe = (
      line: string,
      startupPhases: Array<Readonly<Record<string, string | number>>>,
    ) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.tag === "AH10_PROBE") events.push(value as unknown as Probe);
        if (
          value.tag === "AH19_STARTUP_PHASE" &&
          typeof value.phase === "string"
        ) {
          const phase = {
            phase: value.phase,
            ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
            ...(typeof value.exitCode === "number"
              ? { exitCode: value.exitCode }
              : {}),
            ...(typeof value.elapsedMs === "number"
              ? { elapsedMs: value.elapsedMs }
              : {}),
          };
          startupPhases.push(phase);
        }
      } catch {
        // The fixture retains stdout and stderr for failure diagnostics.
      }
    };
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      preserveDirectoryOnStop: true,
      daemonEnvironment: { ARBOR_AH19_STARTUP_TRACE: "1" },
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          context.includes(marker) &&
          available.has("assign_work") &&
          !available.has("claim_completion")
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}.` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Complete ${marker}.`,
                  why: "qualify stale P9 direct Control effect suppression",
                  constraints: [],
                  completionExpectation: `Verify ${marker}.`,
                  verificationMission: {
                    goal: `Verify ${marker}.`,
                    criteria: [
                      {
                        criterionId: "p9-stale-control-effect",
                        requirement: `verify ${marker}`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "P9 live stale Control effect fixture",
                },
              };
        }
        if (available.has(action)) {
          if (!armed) {
            seedWaitIssued = true;
            return manualWait(`seed P9 stale control ${marker}`);
          }
          if (targetCalls.count === 0) {
            targetCalls.count += 1;
            return {
              _tag: "ToolCall",
              name: action,
              arguments: argumentsFor(action, marker),
            };
          }
          return { _tag: "Text", text: `Observed ${action} for ${marker}.` };
        }
        if (available.has("claim_completion")) {
          seedWaitIssued = true;
          return manualWait(`seed P9 stale control ${marker}`);
        }
        return { _tag: "Text", text: `Observed ${marker}.` };
      },
      onDaemonStdout: (line) => captureProbe(line, oldStartupPhases),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `P9 live stale ${action} suppression`,
      { resourceSelection: "Profile" },
    );
    const work = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit Work ${marker} for stale control-effect suppression.`,
    );
    const waitingWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: unknown;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (current) =>
        seedWaitIssued &&
        current?.workId === work.workId &&
        current.status === "Open" &&
        current.activeExecution === undefined,
    );
    if (waitingWork?.workId !== work.workId) {
      throw new Error("P9 live stale fixture did not reach its Manual wait");
    }

    await fixture.crash();
    armed = true;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ...p39WindowsTestEnvironment(),
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_CONTROL_EFFECT_KIND: action,
        ARBOR_AH10_EMIT_STALE_GATE_RELEASE: "1",
        ARBOR_AH10_GATE_ACTION_KIND: action,
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: work.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: waitingWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume stale-generation ${action} for ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const oldIntent = await waitForActionIntent({
      fixture,
      events,
      role: "old",
      action,
    });
    if (oldIntent.logicalActionId === undefined) {
      throw new Error("old stale fixture ActionIntent has no LogicalActionId");
    }
    expect(oldIntent).toMatchObject({ routeKind: "Control" });
    const oldLease = expireLiveOwnerLeaseForStaleProbe(
      fixture.databaseFile,
      oldIntent.executionId,
    );
    expect(oldLease.generation).toBe(0);

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: childEntry,
      daemonEnvironment: {
        ...p39WindowsTestEnvironment(),
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_CONTROL_EFFECT_KIND: action,
        ARBOR_AH10_GATE_ACTION_KIND: action,
        ARBOR_AH19_STARTUP_TRACE: "1",
      },
      onStdout: (line) => captureProbe(line, newStartupPhases),
    });
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldIntent.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    ).catch((error: unknown) =>
      captureGen1TakeoverWaitFailure({
        fixture,
        newDaemon,
        events,
        action,
        marker,
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId: work.workId,
        oldIntent,
        oldLease,
        targetCalls: targetCalls.count,
        armed,
        seedWaitIssued,
        startupPhases: newStartupPhases,
        oldStartupPhases,
        providerCalls: fixture.providerCalls,
        gateFiles: readdirSync(resolve(fixture.directory, "ah10-gates")),
        waitError: error,
      }),
    );
    const newIntent = await releaseActionIntentGate({
      fixture,
      events,
      role: "new",
      action,
      executionId: oldIntent.executionId,
      logicalActionId: oldIntent.logicalActionId,
    });
    expect(newIntent).toMatchObject({
      providerTurnId: oldIntent.providerTurnId,
      callRef: oldIntent.callRef,
      routeKind: "Control",
    });
    const gen1Committed = await waitForPublic(
      async () =>
        readEffects(fixture.databaseFile, {
          action,
          workId: work.workId,
          parentWorkspaceId: project.rootWorkspaceId,
          marker,
        }),
      (snapshot) =>
        snapshot.effectCount === 1 && snapshot.action?.state === "Applied",
      45_000,
    );
    expect(gen1Committed.resultCount).toBe(1);
    if (action === "update_plan") {
      releaseGate(fixture, "new", "action-result");
    } else {
      expect(gen1Committed.action?.step_state).toBe("SettlementProposed");
    }

    releaseGate(fixture, "old", "action-intent");
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7ActionIntentGateReleased" &&
            event.executionId === oldIntent.executionId &&
            event.logicalActionId === oldIntent.logicalActionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    const suppressed = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7StaleDirectControlEffectSuppressed" &&
            event.executionId === oldIntent.executionId &&
            event.logicalActionId === oldIntent.logicalActionId &&
            event.staleEffectSuppressed === true,
        ),
      (event) => event !== undefined,
      5_000,
    ).catch(() => undefined);
    if (suppressed !== undefined) {
      expect(suppressed).toMatchObject({
        actionKind: action,
        routeKind: "Control",
      });
      expect(["P9ActionApplied", "P9StepNoLongerActionable"]).toContain(
        suppressed.stage,
      );
    } else {
      // The expired gen0 worker may be cancelled by P2 before its handler
      // reaches the application suppression seam. The child gate release is
      // observed above; this bounded quiescence still proves it emitted no
      // competing effect/result/Action mutation.
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    const final = readEffects(fixture.databaseFile, {
      action,
      workId: work.workId,
      parentWorkspaceId: project.rootWorkspaceId,
      marker,
    });
    expect(final.effectCount).toBe(1);
    expect(final.resultCount).toBe(1);
    expect(final.action).toMatchObject({
      execution_id: oldIntent.executionId,
      logical_action_id: oldIntent.logicalActionId,
      call_ref: oldIntent.callRef,
      state: "Applied",
    });
    expect(targetCalls.count).toBe(1);
    const leaseDb = new DatabaseSync(fixture.databaseFile, {
      readOnly: true,
    });
    try {
      expect(
        leaseDb
          .prepare(
            "SELECT generation FROM execution_leases WHERE execution_id=?",
          )
          .get(oldIntent.executionId),
      ).toMatchObject({ generation: 1 });
    } finally {
      leaseDb.close();
    }
  });
const releaseActionIntentGate = async (input: {
  readonly fixture: ProductionFixture;
  readonly events: ReadonlyArray<Probe>;
  readonly role: "old" | "new";
  readonly action: ActionKind;
  readonly executionId?: string;
  readonly logicalActionId?: string;
}) => {
  const intent = await waitForActionIntent(input);
  releaseGate(input.fixture, input.role, "action-intent");
  return intent;
};

const readEffects = (
  databaseFile: string,
  input: {
    readonly action: ActionKind;
    readonly workId: string;
    readonly parentWorkspaceId: string;
    readonly marker: string;
  },
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const action = db
      .prepare(
        `SELECT a.execution_id, a.logical_action_id, a.call_ref, a.action_kind,
                a.state, a.result_ref, a.settlement_ref, s.state AS step_state,
                s.next_action_index, s.settlement_json
         FROM agent_loop_step_actions a JOIN agent_loop_steps s
           ON s.execution_id=a.execution_id AND s.logical_step_no=a.logical_step_no
          AND s.repair_attempt=a.repair_attempt
         WHERE a.action_kind=? ORDER BY s.updated_at DESC, a.action_index DESC LIMIT 1`,
      )
      .get(input.action) as
      | {
          execution_id: string;
          logical_action_id: string;
          call_ref: string;
          action_kind: string;
          state: string;
          result_ref: string | null;
          settlement_ref: string | null;
          step_state: string;
          next_action_index: number;
          settlement_json: string | null;
        }
      | undefined;
    const effectCount =
      input.action === "update_plan"
        ? (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM work_plans WHERE work_id=?",
              )
              .get(input.workId) as { count: number }
          ).count
        : input.action === "claim_completion"
          ? (
              db
                .prepare(
                  "SELECT COUNT(*) AS count FROM work_waits WHERE work_id=?",
                )
                .get(input.workId) as { count: number }
            ).count
          : (
              db
                .prepare(
                  "SELECT COUNT(*) AS count FROM formation_proposals WHERE parent_workspace_id=? AND proposal_json LIKE ?",
                )
                .get(input.parentWorkspaceId, `%${input.marker}%`) as {
                count: number;
              }
            ).count;
    const formationFulfillmentCount =
      input.action === "propose_workspace"
        ? (
            db
              .prepare(
                `SELECT COUNT(*) AS count FROM formation_fulfillments f
                 JOIN formation_proposals p ON p.proposal_id=f.proposal_id
                 WHERE p.parent_workspace_id=? AND p.proposal_json LIKE ?`,
              )
              .get(input.parentWorkspaceId, `%${input.marker}%`) as {
              count: number;
            }
          ).count
        : 0;
    const governanceInboxCount =
      input.action === "propose_workspace"
        ? (
            db
              .prepare(
                `SELECT COUNT(*) AS count FROM inbox_entries i
                 WHERE i.workspace_id=? AND i.kind='Governance'
                   AND i.entry_key IN (
                     SELECT 'gov:' || proposal_id || ':' || revision
                     FROM formation_proposals
                     WHERE parent_workspace_id=? AND proposal_json LIKE ?
                   )`,
              )
              .get(
                input.parentWorkspaceId,
                input.parentWorkspaceId,
                `%${input.marker}%`,
              ) as {
              count: number;
            }
          ).count
        : 0;
    const resultRows = db
      .prepare(
        "SELECT COUNT(*) AS count FROM session_entries WHERE source_kind='AgentLoopAction' AND payload_json LIKE ?",
      )
      .get(`%${input.action}%`) as { count: number };
    return {
      action,
      effectCount,
      formationFulfillmentCount,
      governanceInboxCount,
      resultCount: resultRows.count,
    };
  } finally {
    db.close();
  }
};

const expireLiveOwnerLeaseForStaleProbe = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    const before = db
      .prepare(
        "SELECT execution_id,worker_id,worker_incarnation_id,generation,expires_at FROM execution_leases WHERE execution_id=?",
      )
      .get(executionId) as
      | {
          execution_id: string;
          worker_id: string;
          worker_incarnation_id: string;
          generation: number;
          expires_at: string;
        }
      | undefined;
    if (before === undefined) throw new Error("old Worker lease is missing");
    const update = db
      .prepare(
        "UPDATE execution_leases SET expires_at=? WHERE execution_id=? AND worker_id=? AND worker_incarnation_id=? AND generation=? AND expires_at=?",
      )
      .run(
        "1970-01-01T00:00:00.000Z",
        before.execution_id,
        before.worker_id,
        before.worker_incarnation_id,
        before.generation,
        before.expires_at,
      );
    if (update.changes !== 1) {
      throw new Error("live old Worker lease changed before test CAS");
    }
    db.exec("COMMIT");
    return before;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original qualification failure.
    }
    throw error;
  } finally {
    db.close();
  }
};

const argumentsFor = (action: ActionKind, marker: string) => {
  switch (action) {
    case "update_plan":
      return {
        items: [
          {
            itemId: `p9-${marker}`,
            text: `track ${marker}`,
            status: "InProgress",
          },
        ],
      };
    case "claim_completion":
      return { claim: `claim ${marker} for verification` };
    case "propose_workspace":
      return {
        name: `child-${marker}`,
        rationale: `separate responsibility for ${marker}`,
        responsibilityDraft: {
          purpose: `own ${marker}`,
          ownedResponsibilities: [`${marker}-responsibility`],
        },
        resourceBoundaryDraft: {
          addresses: [{ _tag: "FileTree", path: `services/${marker}` }],
        },
      };
  }
};

const qualifies = (action: ActionKind, boundary: Boundary) =>
  it(`${action} commits its direct effect with the P9 terminal/action handoff at ${boundary}`, async () => {
    const marker = `P9-${action}-${crypto.randomUUID().slice(0, 7)}`;
    const events: Probe[] = [];
    const targetCalls = { count: 0 };
    let armed = false;
    let seedWaitIssued = false;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      preserveDirectoryOnStop: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          context.includes(marker) &&
          available.has("assign_work") &&
          !available.has("claim_completion")
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}.` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Complete ${marker}.`,
                  why: "qualify P9 direct Control action effect takeover",
                  constraints: [],
                  completionExpectation: `Verify ${marker}.`,
                  verificationMission: {
                    goal: `Verify ${marker}.`,
                    criteria: [
                      {
                        criterionId: "p9-direct-control-effect",
                        requirement: `verify ${marker}`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "P9 direct Control effect takeover fixture",
                },
              };
        }
        if (available.has(action)) {
          if (!armed) {
            seedWaitIssued = true;
            return manualWait(`seed P9 control takeover ${marker}`);
          }
          if (targetCalls.count === 0) {
            targetCalls.count += 1;
            return {
              _tag: "ToolCall",
              name: action,
              arguments: argumentsFor(action, marker),
            };
          }
          return {
            _tag: "Text",
            text: `Observed durable ${action} for ${marker}.`,
          };
        }
        if (available.has("claim_completion")) {
          seedWaitIssued = true;
          return manualWait(`seed P9 control takeover ${marker}`);
        }
        return { _tag: "Text", text: `Observed ${marker}.` };
      },
      onDaemonStdout: (line) => {
        try {
          const event = JSON.parse(line) as Probe;
          if (event.tag === "AH10_PROBE") events.push(event);
        } catch {
          // The fixture retains stdout and stderr for failure diagnostics.
        }
      },
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `P9 ${action} direct effect takeover`,
      { resourceSelection: "Profile" },
    );
    const work = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit Work ${marker} for direct Control recovery.`,
    );
    const waitingWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: unknown;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (current) =>
        seedWaitIssued &&
        current?.workId === work.workId &&
        current.status === "Open" &&
        current.activeExecution === undefined,
    );
    if (waitingWork?.workId !== work.workId) {
      throw new Error(
        "P9 direct Control fixture did not reach its Manual wait",
      );
    }

    await fixture.crash();
    armed = true;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ...p39WindowsTestEnvironment(),
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_CONTROL_EFFECT_BOUNDARY: boundary,
        ARBOR_AH10_CONTROL_EFFECT_KIND: action,
        ARBOR_AH10_GATE_ACTION_KIND: action,
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: work.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: waitingWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume P9 action ${action} for ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    if (boundary !== "AH7AfterActionIntentCommit") {
      await releaseActionIntentGate({
        fixture,
        events,
        role: "old",
        action,
      });
    }
    const oldProbe = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === boundary &&
            event.actionKind === action &&
            (boundary === "AH7AfterActionIntentCommit" ||
              event.controlEffectGate === true),
        ),
      (event) => event !== undefined,
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `old ${boundary} probe was absent: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; action=${JSON.stringify(readEffects(fixture.databaseFile, { action, workId: work.workId, parentWorkspaceId: project.rootWorkspaceId, marker }))}; daemonErrors=${fixture.daemonErrors.join(" | ")}; providerCalls=${fixture.providerCalls.length}`,
      );
    });
    if (oldProbe === undefined) throw new Error(`missing ${boundary} probe`);
    if (oldProbe.logicalActionId === undefined) {
      throw new Error("old action probe has no LogicalActionId");
    }
    const beforeRestart = readEffects(fixture.databaseFile, {
      action,
      workId: work.workId,
      parentWorkspaceId: project.rootWorkspaceId,
      marker,
    });
    expect(beforeRestart.effectCount).toBe(
      boundary === "AH7AfterActionResultCommit" ||
        boundary === "AH9AfterTerminalActionCommit"
        ? 1
        : 0,
    );
    if (action === "propose_workspace") {
      const expectedCommitted = boundary === "AH7AfterActionResultCommit";
      expect(beforeRestart.formationFulfillmentCount).toBe(
        expectedCommitted ? 1 : 0,
      );
      expect(beforeRestart.governanceInboxCount).toBe(
        expectedCommitted ? 1 : 0,
      );
    }
    if (beforeRestart.action === undefined) {
      throw new Error(`${action} P9 action record was not queryable`);
    }
    expect(beforeRestart.action.state).toBe(
      boundary === "AH7AfterActionResultCommit" ||
        boundary === "AH9AfterTerminalActionCommit"
        ? "Applied"
        : "Pending",
    );

    await fixture.crash();
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldProbe.executionId,
      daemon: {
        crash: fixture.crash,
        snapshot: fixture.daemonProcessSnapshot,
      },
    });
    const newDaemon = await fixture.startAdditionalDaemon({
      entry: childEntry,
      daemonEnvironment: {
        ...p39WindowsTestEnvironment(),
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_CONTROL_EFFECT_KIND: action,
        ARBOR_AH10_GATE_ACTION_KIND: action,
      },
      onStdout: (line) => {
        try {
          const event = JSON.parse(line) as Probe;
          if (event.tag === "AH10_PROBE") events.push(event);
        } catch {
          // The fixture retains stdout and stderr for failure diagnostics.
        }
      },
    });
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldProbe.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `gen1 did not acquire the old Execution lease: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readEffects(fixture.databaseFile, { action, workId: work.workId, parentWorkspaceId: project.rootWorkspaceId, marker }))}; daemonErrors=${newDaemon.daemonErrors.join(" | ")}`,
      );
    });
    const effectCommittedBeforeCrash =
      boundary === "AH7AfterActionResultCommit" ||
      boundary === "AH9AfterTerminalActionCommit";
    if (!effectCommittedBeforeCrash) {
      await releaseActionIntentGate({
        fixture,
        events,
        role: "new",
        action,
        executionId: oldProbe.executionId,
        logicalActionId: oldProbe.logicalActionId,
      });
    }
    const recovered = await waitForPublic(
      async () =>
        readEffects(fixture.databaseFile, {
          action,
          workId: work.workId,
          parentWorkspaceId: project.rootWorkspaceId,
          marker,
        }),
      (snapshot) =>
        snapshot.effectCount === 1 && snapshot.action?.state === "Applied",
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `gen1 did not atomically recover ${action}: ${error instanceof Error ? error.message : String(error)}; daemonErrors=${newDaemon.daemonErrors.join(" | ")}; providerCalls=${fixture.providerCalls.length}`,
      );
    });
    expect(recovered.action).toMatchObject({
      action_kind: action,
      state: "Applied",
    });
    expect(recovered.resultCount).toBe(1);
    if (action === "propose_workspace") {
      expect(recovered.effectCount).toBe(1);
      expect(recovered.formationFulfillmentCount).toBe(1);
      expect(recovered.governanceInboxCount).toBe(1);
    }
    if (boundary === "AH7AfterActionResultCommit") {
      releaseGate(fixture, "new", "action-result");
    }
    expect(targetCalls.count).toBe(1);
    if (action === "claim_completion") {
      expect(recovered.action?.step_state).toBe("SettlementProposed");
    } else {
      expect(recovered.action?.next_action_index).toBe(1);
    }
  });

describe("P9 direct Control effect process takeover", () => {
  const cases: ReadonlyArray<readonly [ActionKind, Boundary]> = [
    ["propose_workspace", "AH7AfterActionIntentCommit"],
    ["propose_workspace", "AH7BeforeActionResultCommit"],
    ["propose_workspace", "AH7AfterActionResultCommit"],
    ["update_plan", "AH7AfterActionIntentCommit"],
    ["update_plan", "AH7BeforeActionResultCommit"],
    ["update_plan", "AH7AfterActionResultCommit"],
    ["claim_completion", "AH7AfterActionIntentCommit"],
    ["claim_completion", "AH7BeforeActionResultCommit"],
    ["claim_completion", "AH9AfterTerminalActionCommit"],
  ];
  for (const [action, boundary] of cases) qualifies(action, boundary);
  qualifiesLiveStaleGenerationSuppression("update_plan");
  qualifiesLiveStaleGenerationSuppression("claim_completion");
});
