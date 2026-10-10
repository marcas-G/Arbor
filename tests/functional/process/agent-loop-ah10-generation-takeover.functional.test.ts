import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  proposeAndApproveChildWithInitialWork,
  waitForPublic,
} from "../support/public-client.js";
import { makeWorkProvider } from "../support/work-provider.js";

interface Ah10Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
  readonly commandId?: string;
}

interface Ah10CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface Ah10DeliverableRow {
  readonly deliverable_id: string;
  readonly source_work_id: string;
  readonly kind: string;
}

interface Ah10DependencyRow {
  readonly dependency_id: string;
  readonly project_id: string;
  readonly consumer_work_id: string;
  readonly producer_binding: string;
  readonly expected_deliverable: string;
  readonly revision: number;
  readonly state: string;
}

interface Ah10AcceptanceRow {
  readonly acceptance_id: string;
  readonly project_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly verification_id: string;
}

interface Ah10ProviderAttemptRow {
  readonly provider_turn_id: string;
  readonly attempt_no: number;
  readonly outcome: string;
  readonly settled_at: string | null;
}

const fixtures: ProductionFixture[] = [];

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const pushProbe = (events: Ah10Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Ah10Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Daemon logs are retained by the fixture for failure diagnostics.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

const readAh10Rows = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all() as Array<{
        execution_id: string;
        generation: number;
        expires_at: string;
      }>,
      commands: db
        .prepare(
          "SELECT command_id, resolution, result_json, terminal_error_json FROM commands",
        )
        .all() as unknown as Ah10CommandRow[],
      works: db
        .prepare(
          "SELECT work_id, project_id, workspace_id, objective, lifecycle, revision FROM works ORDER BY created_at",
        )
        .all() as Array<{
        work_id: string;
        project_id: string;
        workspace_id: string;
        objective: string;
        lifecycle: string;
        revision: number;
      }>,
      deliverables: db
        .prepare(
          "SELECT deliverable_id, source_work_id, kind FROM deliverables ORDER BY created_at",
        )
        .all() as unknown as Ah10DeliverableRow[],
      dependencies: db
        .prepare(
          `SELECT dependency_id, project_id, consumer_work_id, producer_binding,
                  expected_deliverable, revision, state
             FROM dependencies ORDER BY dependency_id`,
        )
        .all() as unknown as Ah10DependencyRow[],
      acceptances: db
        .prepare(
          `SELECT acceptance_id, project_id, work_id, target_work_revision,
                  verification_id FROM work_acceptances ORDER BY acceptance_id`,
        )
        .all() as unknown as Ah10AcceptanceRow[],
      providerAttempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, settled_at FROM provider_attempts ORDER BY provider_turn_id, attempt_no",
        )
        .all() as unknown as Ah10ProviderAttemptRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.action_index, a.observation_source_ref,
                  a.call_ref, a.action_kind, a.state
             FROM agent_loop_step_actions a
             JOIN agent_loop_steps s
               ON s.execution_id = a.execution_id
              AND s.logical_step_no = a.logical_step_no
              AND s.repair_attempt = a.repair_attempt
            ORDER BY a.action_index`,
        )
        .all() as Array<{
        execution_id: string;
        provider_turn_id: string;
        logical_action_id: string;
        action_index: number;
        observation_source_ref: string | null;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
      domainEvents: db
        .prepare(
          "SELECT sequence, project_id, event_type, aggregate_ref, caused_by_command_id, payload_json FROM domain_events ORDER BY sequence",
        )
        .all() as Array<{
        sequence: number;
        project_id: string;
        event_type: string;
        aggregate_ref: string;
        caused_by_command_id: string | null;
        payload_json: string;
      }>,
      actionObservations: db
        .prepare(
          `SELECT se.entry_kind, se.source_kind, se.source_ref, se.payload_json
             FROM session_entries se
            WHERE se.source_kind = 'AgentLoopAction'
              AND se.entry_kind = 'Observation'
            ORDER BY se.sequence`,
        )
        .all() as Array<{
        entry_kind: string;
        source_kind: string;
        source_ref: string;
        payload_json: string;
      }>,
    };
  } finally {
    db.close();
  }
};

describe("AH10 real daemon generation takeover", () => {
  it.each(["before", "after"] as const)(
    "crashes the old owner %s its fence receipt commit, then lets the new owner commit once",
    async (crashSide) => {
      const marker = `AH10-${crypto.randomUUID().slice(0, 8)}`;
      const events: Ah10Probe[] = [];
      const providerMarkerCalls: string[] = [];
      let probeArmed = false;
      let seedWaitIssued = false;
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (
            context.includes(marker) &&
            !available.has("claim_completion") &&
            available.has("assign_work")
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Parent Work admitted for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Exercise AH10 takeover ${marker}.`,
                    why: "qualify old owner fencing and new owner receipt lookup",
                    constraints: [],
                    completionExpectation:
                      "the pinned action commits one Deliverable",
                    verificationMission: {
                      goal: `Verify AH10 source Work ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah10-source-open",
                          requirement:
                            "the source Work remains open during takeover",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH10 process fixture",
                  },
                };
          }
          if (
            context.includes(marker) &&
            available.has("produce_deliverable")
          ) {
            if (!probeArmed) {
              seedWaitIssued = true;
              return manualWait(
                `AH10 seed Work waits for takeover probe ${marker}`,
              );
            }
            providerMarkerCalls.push(`provider-call-${index}`);
            return {
              _tag: "ToolCall",
              name: "produce_deliverable",
              arguments: { kind: "report", artifacts: [] },
            };
          }
          return { _tag: "HttpError", status: 422 };
        },
        onDaemonStdout: (line) => pushProbe(events, line),
      });
      fixtures.push(fixture);
      mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH10 real daemon takeover",
      );
      const sourceWork = await admitRootWorkThroughPublicConversation(
        client,
        project,
        marker,
        `Please create the AH10 takeover Parent Work ${marker}.`,
      );
      const sourceWorkId = sourceWork.workId;
      const seedWorkAtWait = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (work) =>
          seedWaitIssued &&
          work?.workId === sourceWorkId &&
          work.status === "Open" &&
          work.activeExecution === undefined,
      );
      if (seedWorkAtWait === null || seedWorkAtWait.workId !== sourceWorkId) {
        throw new Error("AH10 public seed Work did not reach its Manual wait");
      }
      expect(seedWorkAtWait).toMatchObject({
        workId: sourceWorkId,
        revision: 0,
        status: "Open",
      });
      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
        },
      });
      await client.command(project.projectId, "SteerWork", {
        workId: sourceWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: seedWorkAtWait.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume the measured AH10 action ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });

      const oldActionGate = (event: Ah10Probe) =>
        event.role === "old" &&
        event.boundary === "AH7AfterActionIntentCommit" &&
        event.actionIndex === 0;
      const oldLeasePause = (event: Ah10Probe) =>
        event.role === "old" && event.boundary === "AH10BeforeLeaseRenewal";
      const oldAction = await waitForPublic(
        async () => events.find(oldActionGate),
        (event) => event !== undefined,
        30_000,
      );
      if (oldAction === undefined)
        throw new Error("AH10 old action gate is absent");
      expect(oldAction?.providerTurnId).toMatch(/^ptn_/u);
      expect(oldAction?.executionId).toMatch(/^exe_/u);
      await waitForPublic(
        async () => events.find(oldLeasePause),
        (event) => event !== undefined,
        20_000,
      );

      const oldLease = readAh10Rows(fixture.databaseFile).leases.find(
        (lease) => lease.execution_id === oldAction?.executionId,
      );
      expect(oldLease).toMatchObject({ generation: 0 });
      if (oldLease === undefined)
        throw new Error("AH10 old lease row is absent");
      await waitForPublic(
        async () =>
          readAh10Rows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const newLease = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(newLease?.fencingGeneration).toBe(1);
      const newAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
      expect(newAction?.callRef).toBe(oldAction.callRef);
      expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

      // Let the still-live generation-0 process attempt its actual canonical
      // command only after the DB lease has advanced to generation 1.
      releaseGate(fixture, "old", "action-intent");
      if (crashSide === "before") {
        const beforeCommit = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeFencedReceiptCommit" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          15_000,
        );
        expect(beforeCommit?.commandId).toMatch(/^cmd_/u);
        expect(
          readAh10Rows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      } else {
        const fencedReceipt = await waitForPublic(
          async () =>
            readAh10Rows(fixture.databaseFile).commands.filter(
              (command) =>
                command.resolution === "TerminalRejected" &&
                command.terminal_error_json?.includes("FencingRejected"),
            ),
          (rows) => rows.length === 1,
          15_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH10 old owner did not persist its fence receipt: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readAh10Rows(fixture.databaseFile))}; oldErrors=${fixture.daemonErrors.join(" | ")}; newErrors=${newDaemon.daemonErrors.join(" | ")}`,
          );
        });
        expect(fencedReceipt).toHaveLength(1);
      }
      expect(readAh10Rows(fixture.databaseFile).works).toHaveLength(1);
      await fixture.crash();

      // The gen-1 handler must see the persisted gen-0 FencingRejected receipt
      // before it sends its generation-scoped command.
      releaseGate(fixture, "new", "action-intent");
      const newActionResult = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionResultCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      expect(newActionResult?.providerTurnId).toBe(oldAction.providerTurnId);

      const final = readAh10Rows(fixture.databaseFile);
      const rejected = final.commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      );
      const committed = final.commands.filter((command) => {
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
          return false;
        }
        const result = JSON.parse(command.result_json) as {
          readonly sourceWorkId?: string;
          readonly kind?: string;
        };
        return result.sourceWorkId === sourceWorkId && result.kind === "report";
      });
      expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
      expect(committed).toHaveLength(1);
      if (crashSide === "after") {
        expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
      }
      expect(final.deliverables).toHaveLength(1);
      expect(final.works).toHaveLength(1);
      expect(final.deliverables[0]).toMatchObject({
        source_work_id: sourceWorkId,
        kind: "report",
      });
      expect(final.actions).toContainEqual(
        expect.objectContaining({
          execution_id: oldAction.executionId,
          provider_turn_id: oldAction.providerTurnId,
          action_index: 0,
          call_ref: oldAction.callRef,
          action_kind: "produce_deliverable",
          state: "Applied",
        }),
      );
      expect(providerMarkerCalls).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);
      expect(fixture.daemonErrors).toEqual([]);

      releaseGate(fixture, "new", "action-result");
      await newDaemon.crash();
    },
    120_000,
  );

  it("recovers a committed Deliverable receipt when its Action is still Pending", async () => {
    const marker = `AH10-pending-${crypto.randomUUID().slice(0, 8)}`;
    const events: Ah10Probe[] = [];
    let probeArmed = false;
    let seedWaitIssued = false;
    let targetProviderCalls = 0;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          context.includes(marker) &&
          !available.has("claim_completion") &&
          available.has("assign_work")
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Parent Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Exercise pending action takeover ${marker}.`,
                  why: "qualify canonical receipt recovery before Action result commit",
                  constraints: [],
                  completionExpectation:
                    "the pinned action commits one Deliverable",
                  verificationMission: {
                    goal: `Verify AH10 pending Action ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-pending-action",
                        requirement:
                          "the source Work remains open during takeover",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (context.includes(marker) && available.has("produce_deliverable")) {
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(
              `AH10 seed Work waits for pending receipt probe ${marker}`,
            );
          }
          targetProviderCalls += 1;
          return {
            _tag: "ToolCall",
            name: "produce_deliverable",
            arguments: { kind: "report", artifacts: [] },
          };
        }
        return { _tag: "HttpError", status: 422 };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 committed receipt pending-action recovery",
    );
    const sourceWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please create the pending AH10 Work ${marker}.`,
    );
    const sourceWorkId = sourceWork.workId;
    const seedWorkAtWait = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        seedWaitIssued &&
        work?.workId === sourceWorkId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
    );
    if (seedWorkAtWait === null || seedWorkAtWait.workId !== sourceWorkId) {
      throw new Error("AH10 pending seed Work did not reach Manual wait");
    }
    expect(seedWorkAtWait.revision).toBe(0);
    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: sourceWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: seedWorkAtWait.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume pending AH10 Work ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const actionIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (actionIntent === undefined) {
      throw new Error("AH10 initial Action intent probe was absent");
    }
    releaseGate(fixture, "old", "action-intent");

    const afterControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === actionIntent.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      5_000,
    );
    if (afterControlReturn === undefined) {
      throw new Error("AH10 post-control-return probe was absent");
    }
    const beforeCrash = readAh10Rows(fixture.databaseFile);
    const committedBeforeCrash = beforeCrash.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        readonly sourceWorkId?: string;
        readonly kind?: string;
      };
      return result.sourceWorkId === sourceWorkId && result.kind === "report";
    });
    expect(committedBeforeCrash).toHaveLength(1);
    expect(beforeCrash.deliverables).toHaveLength(1);
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: actionIntent.executionId,
        provider_turn_id: actionIntent.providerTurnId,
        logical_action_id: actionIntent.logicalActionId,
        call_ref: actionIntent.callRef,
        action_kind: "produce_deliverable",
        state: "Pending",
      }),
    );
    expect(
      beforeCrash.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${actionIntent.executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(targetProviderCalls).toBe(1);

    await fixture.crash();
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).leases.find(
          (lease) => lease.execution_id === actionIntent.executionId,
        ),
      (lease) =>
        lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
      35_000,
    );
    const recoveryDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const recoveredLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === actionIntent.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(recoveredLease?.fencingGeneration).toBe(1);
    const recoveredIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.executionId === actionIntent.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(recoveredIntent?.providerTurnId).toBe(actionIntent.providerTurnId);
    expect(recoveredIntent?.callRef).toBe(actionIntent.callRef);
    expect(recoveredIntent?.logicalActionId).toBe(actionIntent.logicalActionId);
    releaseGate(fixture, "new", "action-intent");
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionResultCommit" &&
            event.executionId === actionIntent.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH10 gen-1 action result did not commit: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events)}; rows=${JSON.stringify(readAh10Rows(fixture.databaseFile))}; providerCalls=${fixture.providerCalls.length}; daemonErrors=${recoveryDaemon.daemonErrors.join(" | ")}`,
      );
    });

    const recovered = readAh10Rows(fixture.databaseFile);
    const committedAfterRecovery = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        readonly sourceWorkId?: string;
        readonly kind?: string;
      };
      return result.sourceWorkId === sourceWorkId && result.kind === "report";
    });
    expect(committedAfterRecovery).toHaveLength(1);
    expect(committedAfterRecovery[0]?.command_id).toBe(
      committedBeforeCrash[0]?.command_id,
    );
    expect(recovered.deliverables).toHaveLength(1);
    expect(recovered.actions).toContainEqual(
      expect.objectContaining({
        execution_id: actionIntent.executionId,
        provider_turn_id: actionIntent.providerTurnId,
        logical_action_id: actionIntent.logicalActionId,
        call_ref: actionIntent.callRef,
        action_kind: "produce_deliverable",
        state: "Applied",
      }),
    );
    expect(
      recovered.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${actionIntent.executionId}_`,
        ),
      ),
    ).toHaveLength(1);
    expect(targetProviderCalls).toBe(1);
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    releaseGate(fixture, "new", "action-result");
    await recoveryDaemon.crash();
  }, 90_000);

  it("recovers a committed DeclareDependency receipt while its Action is Pending", async () => {
    const marker = `AH10-dependency-pending-${crypto.randomUUID().slice(0, 8)}`;
    const dependencyKind = `ah10-pending-${marker}`;
    const events: Ah10Probe[] = [];
    let declarationProviderCalls = 0;
    let probeArmed = false;
    let seedWaitIssued = false;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          context.includes(marker) &&
          !available.has("claim_completion") &&
          available.has("assign_work")
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Dependency Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Declare one dependency ${marker}.`,
                  why: "qualify committed dependency receipt recovery before Observation",
                  constraints: [],
                  completionExpectation:
                    "one exact dependency is durably declared",
                  verificationMission: {
                    goal: `Verify dependency declaration ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-dependency-pending-recovery",
                        requirement: "one dependency is durably declared",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (
          declarationProviderCalls === 0 &&
          available.has("declare_dependency") &&
          context.includes(marker)
        ) {
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(
              `AH10 seed Work waits for dependency receipt probe ${marker}`,
            );
          }
          declarationProviderCalls += 1;
          return {
            _tag: "ToolCall",
            name: "declare_dependency",
            arguments: {
              producerBinding: { _tag: "AnyProducer" },
              expectedDeliverable: {
                kind: dependencyKind,
                requiredArtifactRoles: [],
              },
            },
          };
        }
        return { _tag: "Text", text: `Declared dependency for ${marker}.` };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 committed DeclareDependency receipt recovery",
    );
    const consumerWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit the dependency Work ${marker}.`,
    );
    const consumerWorkId = consumerWork.workId;
    const seedWorkAtWait = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        seedWaitIssued &&
        work?.workId === consumerWorkId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
    );
    if (seedWorkAtWait === null || seedWorkAtWait.workId !== consumerWorkId) {
      throw new Error("AH10 dependency seed Work did not reach Manual wait");
    }
    expect(seedWorkAtWait.revision).toBe(0);
    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
        ARBOR_AH10_GATE_ACTION_KIND: "declare_dependency",
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: consumerWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: seedWorkAtWait.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume dependency receipt action ${marker}.`,
      },
      provenance: { source: "HumanInput" },
    });

    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "declare_dependency" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (oldAction === undefined) {
      throw new Error("AH10 committed DeclareDependency ActionIntent absent");
    }
    expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
    expect(oldAction.logicalActionId).toMatch(/^lac_/u);
    expect(oldAction.callRef).toMatch(/^call_/u);
    releaseGate(fixture, "old", "action-intent");
    const oldControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(oldControlReturn).toBeDefined();

    const beforeCrash = readAh10Rows(fixture.databaseFile);
    const dependencyReceipt = beforeCrash.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        dependencyId?: string;
        consumerWorkId?: string;
        state?: string;
        revision?: number;
      };
      return (
        result.consumerWorkId === consumerWorkId &&
        result.state === "Unsatisfied"
      );
    });
    expect(dependencyReceipt).toHaveLength(1);
    const resultBeforeCrash = JSON.parse(
      dependencyReceipt[0]?.result_json ?? "{}",
    ) as { dependencyId?: string };
    expect(resultBeforeCrash.dependencyId).toMatch(/^dep_/u);
    expect(beforeCrash.dependencies).toEqual([
      expect.objectContaining({
        dependency_id: resultBeforeCrash.dependencyId,
        project_id: project.projectId,
        consumer_work_id: consumerWorkId,
        state: "Unsatisfied",
        revision: 0,
      }),
    ]);
    const declarationEvents = beforeCrash.domainEvents.filter(
      (event) =>
        event.project_id === project.projectId &&
        event.event_type === "DependencyDeclared" &&
        event.aggregate_ref === resultBeforeCrash.dependencyId,
    );
    expect(declarationEvents).toHaveLength(1);
    expect(declarationEvents[0]?.caused_by_command_id).toBe(
      dependencyReceipt[0]?.command_id,
    );
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "declare_dependency",
        state: "Pending",
      }),
    );
    expect(
      beforeCrash.actionObservations.filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
      ),
    ).toHaveLength(0);
    expect(
      beforeCrash.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    expect(declarationProviderCalls).toBe(1);

    await fixture.crash();
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).leases.find(
          (lease) => lease.execution_id === oldAction.executionId,
        ),
      (lease) =>
        lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
      35_000,
    );
    const recoveryDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        ARBOR_AH10_GATE_ACTION_KIND: "declare_dependency",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const recoveredLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(recoveredLease?.fencingGeneration).toBe(1);
    const recoveredIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.executionId === oldAction.executionId &&
            event.actionKind === "declare_dependency" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(recoveredIntent?.providerTurnId).toBe(oldAction.providerTurnId);
    expect(recoveredIntent?.logicalActionId).toBe(oldAction.logicalActionId);
    expect(recoveredIntent?.callRef).toBe(oldAction.callRef);
    releaseGate(fixture, "new", "action-intent");
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionResultCommit" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );

    const recovered = readAh10Rows(fixture.databaseFile);
    const recoveredReceipts = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        dependencyId?: string;
        consumerWorkId?: string;
      };
      return (
        result.dependencyId === resultBeforeCrash.dependencyId &&
        result.consumerWorkId === consumerWorkId
      );
    });
    expect(recoveredReceipts).toHaveLength(1);
    expect(recoveredReceipts[0]?.command_id).toBe(
      dependencyReceipt[0]?.command_id,
    );
    expect(recovered.dependencies).toEqual(beforeCrash.dependencies);
    expect(
      recovered.domainEvents.filter(
        (event) =>
          event.project_id === project.projectId &&
          event.event_type === "DependencyDeclared" &&
          event.aggregate_ref === resultBeforeCrash.dependencyId,
      ),
    ).toHaveLength(1);
    expect(recovered.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "declare_dependency",
        state: "Applied",
      }),
    );
    const actionObservation = recovered.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId,
    )?.observation_source_ref;
    expect(actionObservation).toMatch(/^observation_/u);
    expect(
      recovered.actionObservations.filter(
        (observation) => observation.source_ref === actionObservation,
      ),
    ).toHaveLength(1);
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    expect(declarationProviderCalls).toBe(1);
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    releaseGate(fixture, "new", "action-result");
    await recoveryDaemon.crash();
  }, 150_000);

  it.each(["before", "after"] as const)(
    "takes over DeclareDependency after killing the old owner %s its FencingRejected receipt commits",
    async (crashSide) => {
      const marker = `AH10-dependency-${crypto.randomUUID().slice(0, 8)}`;
      const dependencyKind = `ah10-dependency-${marker}`;
      const events: Ah10Probe[] = [];
      const providerMarkerCalls: string[] = [];
      let probeArmed = false;
      let seedWaitIssued = false;
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (
            context.includes(marker) &&
            !available.has("claim_completion") &&
            available.has("assign_work")
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Dependency Work admitted for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Declare dependency ${marker}.`,
                    why: "qualify generation-scoped dependency command takeover",
                    constraints: [],
                    completionExpectation:
                      "one exact dependency is durably declared",
                    verificationMission: {
                      goal: `Verify dependency declaration ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah10-dependency-declared",
                          requirement:
                            "the dependency is durable and initially unsatisfied",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH10 process fixture",
                  },
                };
          }
          if (
            !context.includes(marker) ||
            !available.has("declare_dependency")
          ) {
            return { _tag: "HttpError", status: 422 };
          }
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(
              `AH10 seed Work waits for dependency takeover probe ${marker}`,
            );
          }
          providerMarkerCalls.push(`provider-call-${index}`);
          return {
            _tag: "ToolCall",
            name: "declare_dependency",
            arguments: {
              producerBinding: { _tag: "AnyProducer" },
              expectedDeliverable: {
                kind: dependencyKind,
                requiredArtifactRoles: [],
              },
            },
          };
        },
        onDaemonStdout: (line) => pushProbe(events, line),
      });
      fixtures.push(fixture);
      mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH10 DeclareDependency generation takeover",
      );
      const consumerWork = await admitRootWorkThroughPublicConversation(
        client,
        project,
        marker,
        `Please admit the dependency Work ${marker}.`,
      );
      const consumerWorkId = consumerWork.workId;
      const seedWorkAtWait = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (work) =>
          seedWaitIssued &&
          work?.workId === consumerWorkId &&
          work.status === "Open" &&
          work.activeExecution === undefined,
      );
      if (seedWorkAtWait === null || seedWorkAtWait.workId !== consumerWorkId) {
        throw new Error("AH10 dependency seed Work did not reach Manual wait");
      }
      expect(seedWorkAtWait.revision).toBe(0);
      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
        },
      });
      await client.command(project.projectId, "SteerWork", {
        workId: consumerWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: seedWorkAtWait.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume dependency takeover action ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });

      const oldAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      if (oldAction === undefined) {
        throw new Error("AH10 old DeclareDependency intent probe was absent");
      }
      expect(oldAction.callRef).toMatch(/^call_/u);
      await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeLeaseRenewal" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        20_000,
      );
      await waitForPublic(
        async () =>
          readAh10Rows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const newLease = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(newLease?.fencingGeneration).toBe(1);
      const newAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
      expect(newAction?.callRef).toBe(oldAction.callRef);
      expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

      releaseGate(fixture, "old", "action-intent");
      if (crashSide === "before") {
        const beforeCommit = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeFencedReceiptCommit" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          15_000,
        );
        expect(beforeCommit?.commandId).toMatch(/^cmd_/u);
        expect(
          readAh10Rows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      } else {
        const fenced = await waitForPublic(
          async () =>
            readAh10Rows(fixture.databaseFile).commands.filter(
              (command) =>
                command.resolution === "TerminalRejected" &&
                command.terminal_error_json?.includes("FencingRejected"),
            ),
          (rows) => rows.length === 1,
          15_000,
        );
        expect(fenced).toHaveLength(1);
      }
      expect(readAh10Rows(fixture.databaseFile).dependencies).toHaveLength(0);
      await fixture.crash();
      if (crashSide === "before") {
        expect(
          readAh10Rows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      }

      releaseGate(fixture, "new", "action-intent");
      await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionResultCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );

      const final = readAh10Rows(fixture.databaseFile);
      const rejected = final.commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      );
      const committed = final.commands.filter((command) => {
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
          return false;
        }
        const result = JSON.parse(command.result_json) as {
          readonly dependencyId?: string;
          readonly consumerWorkId?: string;
          readonly state?: string;
          readonly revision?: number;
        };
        return (
          result.consumerWorkId === consumerWorkId &&
          result.state === "Unsatisfied" &&
          result.revision === 0
        );
      });
      expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
      expect(committed).toHaveLength(1);
      if (crashSide === "after") {
        expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
      }
      expect(final.dependencies).toHaveLength(1);
      expect(final.dependencies[0]).toMatchObject({
        dependency_id: (
          JSON.parse(committed[0]?.result_json ?? "{}") as {
            dependencyId?: string;
          }
        ).dependencyId,
        project_id: project.projectId,
        consumer_work_id: consumerWorkId,
        producer_binding: JSON.stringify({ _tag: "AnyProducer" }),
        expected_deliverable: JSON.stringify({
          kind: dependencyKind,
          requiredArtifactRoles: [],
        }),
        revision: 0,
        state: "Unsatisfied",
      });
      expect(final.actions).toContainEqual(
        expect.objectContaining({
          execution_id: oldAction.executionId,
          provider_turn_id: oldAction.providerTurnId,
          logical_action_id: oldAction.logicalActionId,
          call_ref: oldAction.callRef,
          action_kind: "declare_dependency",
          state: "Applied",
        }),
      );
      expect(
        final.actionObservations.filter((observation) =>
          observation.source_ref.startsWith(
            `observation_${oldAction.executionId}_`,
          ),
        ),
      ).toHaveLength(1);
      expect(providerMarkerCalls).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);
      expect(fixture.daemonErrors).toEqual([]);
      releaseGate(fixture, "new", "action-result");
      await newDaemon.crash();
    },
    120_000,
  );

  it.each(["before", "after"] as const)(
    "takes over AcceptResult when the old FencingRejected receipt is interrupted %s commit",
    async (crashSide) => {
      const childMarker = `AH10-accept-child-${crypto.randomUUID().slice(0, 8)}`;
      const parentMarker = `AH10-accept-parent-${crypto.randomUUID().slice(0, 8)}`;
      const events: Ah10Probe[] = [];
      const acceptResultCalls: Array<{
        readonly providerCallIndex: number;
        readonly resultRef: string;
      }> = [];
      const listWorkspaceCalls: number[] = [];
      const missingResultRefContexts: string[] = [];
      const providerTrace: Array<{
        readonly index: number;
        readonly tools: ReadonlyArray<string | undefined>;
        readonly tail: string;
      }> = [];
      let probeArmed = false;
      let parentSeedWaitIssued = false;
      const childWorkProvider = makeWorkProvider({
        marker: childMarker,
        verdict: "Pass",
      });
      const fixture = await startProductionFixture({
        isolatedPortHandshake: true,
        admitWorkspaceDirectory: true,
        reply: (call, index) => {
          const context = JSON.stringify(call.messages);
          providerTrace.push({
            index,
            tools: call.tools.map((tool) => tool.function?.name),
            tail: context.slice(-1_200),
          });
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          const latestUser = [...call.messages]
            .reverse()
            .find((message) => message.role === "user")?.content;
          if (
            !available.has("claim_completion") &&
            available.has("propose_workspace") &&
            latestUser?.includes(`Propose ${childMarker}`) === true
          ) {
            return context.includes("ProposalRecorded(")
              ? { _tag: "Text", text: `Proposed child ${childMarker}` }
              : {
                  _tag: "ToolCall",
                  name: "propose_workspace",
                  arguments: {
                    name: `child-${childMarker}`,
                    rationale:
                      "produce a verified result for Parent acceptance qualification",
                    responsibilityDraft: {
                      purpose: `produce a verified result for ${childMarker}`,
                      ownedResponsibilities: [childMarker],
                      obligations: ["produce independently verified evidence"],
                      includes: [],
                      excludes: [],
                      interfaces: [],
                    },
                    resourceBoundaryDraft: {
                      addresses: [
                        { _tag: "FileTree", path: fixture.workspaceDirectory },
                      ],
                    },
                    initialWork: {
                      objective: `Complete ${childMarker}.`,
                      why: "prepare a verified child result before parent execution starts",
                      constraints: ["do not perform external side effects"],
                      completionExpectation:
                        "independently verified child result",
                      verificationMission: {
                        goal: `Verify ${childMarker}`,
                        criteria: [
                          {
                            criterionId: "functional-criterion",
                            requirement: `proof.txt contains FUNCTIONAL_VERIFIED for ${childMarker}`,
                            required: true,
                          },
                        ],
                        riskRequirements: ["read-only verification"],
                      },
                    },
                  },
                };
          }
          if (
            !available.has("claim_completion") &&
            available.has("assign_work") &&
            latestUser?.includes(
              `Create Parent Acceptance Work ${parentMarker}`,
            ) === true
          ) {
            return context.includes("WorkAssigned(")
              ? {
                  _tag: "Text",
                  text: `Parent Acceptance Work admitted ${parentMarker}`,
                }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Accept the ready child result ${parentMarker}.`,
                    why: "qualify durable Parent acceptance across owner generations",
                    constraints: [],
                    completionExpectation:
                      "the exact verified child result is accepted",
                    verificationMission: {
                      goal: `Verify Parent acceptance ${parentMarker}`,
                      criteria: [
                        {
                          criterionId: "ah10-parent-acceptance",
                          requirement:
                            "the child PASS result is accepted exactly once",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH10 process fixture",
                  },
                };
          }
          if (
            available.has("claim_completion") &&
            available.has("accept_result") &&
            context.includes(parentMarker) &&
            !probeArmed
          ) {
            parentSeedWaitIssued = true;
            return manualWait(
              `AH10 Parent Acceptance Work waits for probe ${parentMarker}`,
            );
          }
          if (
            context.includes(parentMarker) &&
            available.has("accept_result")
          ) {
            const resultRef = /rref_[a-f0-9]{64}/u.exec(context)?.[0];
            if (resultRef === undefined) {
              if (context.includes("Child result ready")) {
                listWorkspaceCalls.push(index);
                return {
                  _tag: "ToolCall",
                  name: "list_workspaces",
                  arguments: { query: childMarker },
                };
              }
              missingResultRefContexts.push(context.slice(-2_000));
              return {
                _tag: "Text",
                text: "No direct-child ready resultRef was supplied.",
              };
            }
            acceptResultCalls.push({ providerCallIndex: index, resultRef });
            return {
              _tag: "ToolCall",
              name: "accept_result",
              arguments: { resultRef },
            };
          }
          if (context.includes(childMarker)) return childWorkProvider(call);
          return { _tag: "Text", text: "Acceptance qualification setup." };
        },
        onDaemonStdout: (line) => pushProbe(events, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH10 AcceptResult generation takeover",
        { resourceSelection: "Profile" },
      );
      const childDirectory = fixture.workspaceDirectory;
      writeFileSync(
        resolve(childDirectory, "proof.txt"),
        `FUNCTIONAL_VERIFIED for ${childMarker}`,
      );
      const child = await proposeAndApproveChildWithInitialWork(
        client,
        project,
        childMarker,
        `Propose ${childMarker} as a durable producer with its first Work.`,
        {
          name: `child-${childMarker}`,
          initialWork: {
            objective: `Complete ${childMarker}.`,
          },
        },
      );
      const childWorkspaceId = child.workspaceId;
      const childWorkId = child.currentWork.workId;
      expect(child.currentWork.objective).toBe(`Complete ${childMarker}.`);

      const childVerification = await waitForPublic(
        () =>
          client.view<{
            verificationId?: string;
            targetWorkRevision?: number;
            verdict?: string;
            acceptance?: { acceptanceId: string };
          }>("verification", { workId: childWorkId }),
        (view) => view.verdict === "Pass" && view.verificationId !== undefined,
        20_000,
      ).catch((error: unknown) => {
        throw new Error(
          `child Verification did not reach PASS: ${error instanceof Error ? error.message : String(error)}; provider=${JSON.stringify(providerTrace)}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      const childCurrentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision?: number;
            status?: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", { workspaceId: childWorkspaceId }),
        (view) =>
          view !== null &&
          view.workId === childWorkId &&
          view.status === "Open" &&
          view.activeExecution === undefined,
        30_000,
      );
      expect(childVerification).toMatchObject({
        verdict: "Pass",
      });
      expect(childVerification.acceptance).toBeUndefined();
      expect(childCurrentWork).toMatchObject({
        workId: childWorkId,
        status: "Open",
      });
      expect(readAh10Rows(fixture.databaseFile).acceptances).toHaveLength(0);

      const parentWork = await admitRootWorkThroughPublicConversation(
        client,
        project,
        parentMarker,
        `Create Parent Acceptance Work ${parentMarker}`,
      );
      const parentWorkId = parentWork.workId;
      const seedParentWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
        (work) =>
          parentSeedWaitIssued &&
          work?.workId === parentWorkId &&
          work.status === "Open" &&
          work.activeExecution === undefined,
      );
      if (seedParentWork === null || seedParentWork.workId !== parentWorkId) {
        throw new Error(
          "AH10 Parent Acceptance Work did not reach Manual wait",
        );
      }
      expect(seedParentWork.revision).toBe(0);
      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
        },
      });
      mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
      await client.command(project.projectId, "SteerWork", {
        workId: parentWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: seedParentWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume Parent AcceptResult ${parentMarker}.`,
        },
        provenance: { source: "HumanInput" },
      });
      const oldAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "accept_result" &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        15_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AcceptResult-specific ActionIntent was not observed: ${error instanceof Error ? error.message : String(error)}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; missingResultRef=${JSON.stringify(missingResultRefContexts)}; actionIntents=${JSON.stringify(events.filter((event) => event.role === "old" && event.boundary === "AH7AfterActionIntentCommit"))}`,
        );
      });
      if (oldAction === undefined) {
        throw new Error("AH10 old AcceptResult Action intent probe was absent");
      }
      expect(oldAction.callRef).toMatch(/^call_/u);
      expect(listWorkspaceCalls).toHaveLength(1);
      expect(acceptResultCalls).toHaveLength(1);
      expect(acceptResultCalls[0]?.resultRef).toMatch(/^rref_[a-f0-9]{64}$/u);
      const oldLeasePause = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeLeaseRenewal" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        20_000,
      );
      expect(oldLeasePause?.fencingGeneration).toBe(0);
      await waitForPublic(
        async () =>
          readAh10Rows(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
          ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
        },
        onStdout: (line) => pushProbe(events, line),
      });
      const newLease = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === oldAction.executionId,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(newLease?.fencingGeneration).toBe(1);
      const newAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === "accept_result" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      expect(newAction?.providerTurnId).toBe(oldAction.providerTurnId);
      expect(newAction?.callRef).toBe(oldAction.callRef);
      expect(newAction?.logicalActionId).toBe(oldAction.logicalActionId);

      releaseGate(fixture, "old", "action-intent");
      if (crashSide === "before") {
        const beforeCommit = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeFencedReceiptCommit" &&
                event.executionId === oldAction.executionId,
            ),
          (event) => event !== undefined,
          15_000,
        );
        expect(beforeCommit?.commandId).toMatch(/^cmd_/u);
        // readAh10Rows opens a new read-only connection, independent of the
        // old daemon's uncommitted Gateway transaction.
        expect(
          readAh10Rows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      } else {
        const fenced = await waitForPublic(
          async () =>
            readAh10Rows(fixture.databaseFile).commands.filter(
              (command) =>
                command.resolution === "TerminalRejected" &&
                command.terminal_error_json?.includes("FencingRejected"),
            ),
          (rows) => rows.length === 1,
          15_000,
        );
        expect(fenced).toHaveLength(1);
      }
      expect(readAh10Rows(fixture.databaseFile).acceptances).toHaveLength(0);
      await fixture.crash();
      if (crashSide === "before") {
        expect(
          readAh10Rows(fixture.databaseFile).commands.filter(
            (command) =>
              command.resolution === "TerminalRejected" &&
              command.terminal_error_json?.includes("FencingRejected"),
          ),
        ).toHaveLength(0);
      }

      releaseGate(fixture, "new", "action-intent");
      await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionResultCommit" &&
              event.executionId === oldAction.executionId &&
              event.actionIndex === 0,
          ),
        (event) => event !== undefined,
        30_000,
      );
      releaseGate(fixture, "new", "action-result");
      await waitForPublic(
        async () =>
          readAh10Rows(fixture.databaseFile).works.find(
            (work) => work.work_id === childWorkId,
          ),
        (work) => work?.lifecycle === "Completed",
        20_000,
      );

      const final = readAh10Rows(fixture.databaseFile);
      const rejected = final.commands.filter(
        (command) =>
          command.resolution === "TerminalRejected" &&
          command.terminal_error_json?.includes("FencingRejected"),
      );
      const committed = final.commands.filter((command) => {
        if (
          command.resolution !== "Committed" ||
          command.result_json === null
        ) {
          return false;
        }
        const result = JSON.parse(command.result_json) as {
          readonly acceptanceId?: string;
          readonly workId?: string;
          readonly targetWorkRevision?: number;
          readonly verificationId?: string;
        };
        return (
          result.acceptanceId !== undefined &&
          result.workId === childWorkId &&
          result.targetWorkRevision === childVerification.targetWorkRevision &&
          result.verificationId === childVerification.verificationId
        );
      });
      expect(rejected).toHaveLength(crashSide === "before" ? 0 : 1);
      expect(committed).toHaveLength(1);
      expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
      const committedResult = JSON.parse(committed[0]?.result_json ?? "{}") as {
        readonly acceptanceId?: string;
        readonly workId?: string;
        readonly targetWorkRevision?: number;
        readonly verificationId?: string;
      };
      expect(committedResult).toMatchObject({
        acceptanceId: expect.stringMatching(/^acc_/u),
        workId: childWorkId,
        targetWorkRevision: childVerification.targetWorkRevision,
        verificationId: childVerification.verificationId,
      });
      expect(final.acceptances).toEqual([
        expect.objectContaining({
          acceptance_id: committedResult.acceptanceId,
          project_id: project.projectId,
          work_id: childWorkId,
          target_work_revision: childVerification.targetWorkRevision,
          verification_id: childVerification.verificationId,
        }),
      ]);
      expect(
        final.works.find((work) => work.work_id === childWorkId),
      ).toMatchObject({
        project_id: project.projectId,
        workspace_id: childWorkspaceId,
        lifecycle: "Completed",
      });
      const acceptedAction = final.actions.filter(
        (action) =>
          action.execution_id === oldAction.executionId &&
          action.provider_turn_id === oldAction.providerTurnId &&
          action.logical_action_id === oldAction.logicalActionId &&
          action.call_ref === oldAction.callRef &&
          action.action_kind === "accept_result" &&
          action.state === "Applied",
      );
      expect(acceptedAction).toHaveLength(1);
      const observationSourceRef = acceptedAction[0]?.observation_source_ref;
      expect(observationSourceRef).toMatch(/^observation_/u);
      const parentObservations = final.actionObservations.filter(
        (observation) =>
          observation.source_ref.startsWith(
            `observation_${oldAction.executionId}_`,
          ),
      );
      expect(parentObservations).toHaveLength(2);
      expect(
        parentObservations.filter(
          (observation) => observation.source_ref === observationSourceRef,
        ),
      ).toHaveLength(1);
      expect(
        final.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
        ),
      ).toEqual([
        expect.objectContaining({
          outcome: "Success",
          settled_at: expect.any(String),
        }),
      ]);
      expect(acceptResultCalls).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);
      await newDaemon.crash();
    },
    120_000,
  );

  it("recovers a committed AcceptResult receipt while its Action is Pending", async () => {
    const childMarker = `AH10-accept-committed-child-${crypto.randomUUID().slice(0, 8)}`;
    const parentMarker = `AH10-accept-committed-parent-${crypto.randomUUID().slice(0, 8)}`;
    const events: Ah10Probe[] = [];
    const acceptResultCalls: Array<{
      readonly providerCallIndex: number;
      readonly resultRef: string;
    }> = [];
    const listWorkspaceCalls: number[] = [];
    const providerTrace: Array<{
      readonly index: number;
      readonly tools: ReadonlyArray<string | undefined>;
      readonly tail: string;
    }> = [];
    let probeArmed = false;
    let parentSeedWaitIssued = false;
    const childWorkProvider = makeWorkProvider({
      marker: childMarker,
      verdict: "Pass",
    });
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      reply: (call, index) => {
        const context = JSON.stringify(call.messages);
        providerTrace.push({
          index,
          tools: call.tools.map((tool) => tool.function?.name),
          tail: context.slice(-1_200),
        });
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        const latestUser = [...call.messages]
          .reverse()
          .find((message) => message.role === "user")?.content;
        if (
          available.has("propose_workspace") &&
          !available.has("claim_completion") &&
          latestUser?.includes(`Propose ${childMarker}`) === true
        ) {
          return context.includes("ProposalRecorded(")
            ? { _tag: "Text", text: `Proposed child ${childMarker}` }
            : {
                _tag: "ToolCall",
                name: "propose_workspace",
                arguments: {
                  name: `child-${childMarker}`,
                  rationale:
                    "produce a verified result for Parent acceptance qualification",
                  responsibilityDraft: {
                    purpose: `produce a verified result for ${childMarker}`,
                    ownedResponsibilities: [childMarker],
                    obligations: ["produce independently verified evidence"],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  },
                  resourceBoundaryDraft: {
                    addresses: [
                      { _tag: "FileTree", path: fixture.workspaceDirectory },
                    ],
                  },
                  initialWork: {
                    objective: `Complete ${childMarker}.`,
                    why: "prepare a verified child result before the parent execution starts",
                    constraints: ["do not perform external side effects"],
                    completionExpectation:
                      "independently verified child result",
                    verificationMission: {
                      goal: `Verify ${childMarker}`,
                      criteria: [
                        {
                          criterionId: "functional-criterion",
                          requirement: `proof.txt contains FUNCTIONAL_VERIFIED for ${childMarker}`,
                          required: true,
                        },
                      ],
                      riskRequirements: ["read-only verification"],
                    },
                  },
                },
              };
        }
        if (
          !available.has("claim_completion") &&
          available.has("assign_work") &&
          latestUser?.includes(
            `Create Parent Acceptance Work ${parentMarker}`,
          ) === true
        ) {
          return context.includes("WorkAssigned(")
            ? {
                _tag: "Text",
                text: `Parent Acceptance Work admitted ${parentMarker}`,
              }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Accept the ready child result ${parentMarker}.`,
                  why: "qualify committed Parent acceptance recovery before Observation",
                  constraints: [],
                  completionExpectation:
                    "the exact verified child result is accepted",
                  verificationMission: {
                    goal: `Verify Parent acceptance ${parentMarker}`,
                    criteria: [
                      {
                        criterionId:
                          "ah10-parent-acceptance-committed-recovery",
                        requirement:
                          "the exact child PASS result is accepted once",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (
          available.has("claim_completion") &&
          available.has("accept_result") &&
          context.includes(parentMarker) &&
          !probeArmed
        ) {
          parentSeedWaitIssued = true;
          return manualWait(
            `AH10 Parent Acceptance Work waits for probe ${parentMarker}`,
          );
        }
        if (
          available.has("claim_completion") &&
          context.includes(parentMarker) &&
          available.has("accept_result")
        ) {
          if (acceptResultCalls.length > 0) {
            return {
              _tag: "Text",
              text: `Accepted the child result ${parentMarker}.`,
            };
          }
          const resultRef = /rref_[a-f0-9]{64}/u.exec(context)?.[0];
          if (
            resultRef === undefined &&
            context.includes("Child result ready")
          ) {
            listWorkspaceCalls.push(index);
            return {
              _tag: "ToolCall",
              name: "list_workspaces",
              arguments: { query: childMarker },
            };
          }
          if (resultRef === undefined) {
            return { _tag: "HttpError", status: 422 };
          }
          acceptResultCalls.push({ providerCallIndex: index, resultRef });
          return {
            _tag: "ToolCall",
            name: "accept_result",
            arguments: { resultRef },
          };
        }
        if (context.includes(childMarker)) return childWorkProvider(call);
        return { _tag: "Text", text: "Acceptance qualification setup." };
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 committed AcceptResult receipt recovery",
      { resourceSelection: "Profile" },
    );
    const childDirectory = fixture.workspaceDirectory;
    writeFileSync(
      resolve(childDirectory, "proof.txt"),
      `FUNCTIONAL_VERIFIED for ${childMarker}`,
    );
    const child = await proposeAndApproveChildWithInitialWork(
      client,
      project,
      childMarker,
      `Propose ${childMarker} as a durable producer with its first Work.`,
      {
        name: `child-${childMarker}`,
        initialWork: {
          objective: `Complete ${childMarker}.`,
        },
      },
    );
    const childWorkspaceId = child.workspaceId;
    const childWorkId = child.currentWork.workId;
    expect(child.currentWork.objective).toBe(`Complete ${childMarker}.`);
    const childVerification = await waitForPublic(
      () =>
        client.view<{
          verificationId?: string;
          targetWorkRevision?: number;
          verdict?: string;
          acceptance?: { acceptanceId: string };
        }>("verification", { workId: childWorkId }),
      (view) => view.verdict === "Pass" && view.verificationId !== undefined,
      20_000,
    );
    const childCurrentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision?: number;
          status?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: childWorkspaceId }),
      (view) =>
        view?.workId === childWorkId &&
        view.status === "Open" &&
        view.activeExecution === undefined,
      30_000,
    );
    expect(childVerification.verdict).toBe("Pass");
    expect(childVerification.acceptance).toBeUndefined();
    expect(childCurrentWork).toMatchObject({
      workId: childWorkId,
      status: "Open",
    });
    expect(readAh10Rows(fixture.databaseFile).acceptances).toHaveLength(0);

    const parentWork = await admitRootWorkThroughPublicConversation(
      client,
      project,
      parentMarker,
      `Create Parent Acceptance Work ${parentMarker}`,
    );
    const parentWorkId = parentWork.workId;
    const seedParentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) =>
        parentSeedWaitIssued &&
        work?.workId === parentWorkId &&
        work.status === "Open" &&
        work.activeExecution === undefined,
    );
    if (seedParentWork === null || seedParentWork.workId !== parentWorkId) {
      throw new Error(
        "AH10 committed Parent Acceptance Work did not reach Manual wait",
      );
    }
    expect(seedParentWork.revision).toBe(0);
    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
      },
    });
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    await client.command(project.projectId, "SteerWork", {
      workId: parentWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: seedParentWork.revision,
      steer: {
        severity: "Normal",
        guidance: `Resume committed Parent AcceptResult ${parentMarker}.`,
      },
      provenance: { source: "HumanInput" },
    });
    const listActionIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "list_workspaces" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (listActionIntent === undefined) {
      throw new Error(
        "AH10 AcceptResult prerequisite list_workspaces intent absent",
      );
    }
    const listControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === listActionIntent.executionId &&
            event.logicalActionId === listActionIntent.logicalActionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(listControlReturn).toBeDefined();
    releaseGate(fixture, "old", "control-return");
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).actions.find(
          (action) =>
            action.execution_id === listActionIntent.executionId &&
            action.logical_action_id === listActionIntent.logicalActionId,
        ),
      (action) =>
        action?.action_kind === "list_workspaces" &&
        action.state === "Applied" &&
        action.observation_source_ref !== null,
      15_000,
    );
    // Remove only this test fixture's temporary release marker after the
    // public list_workspaces Observation is durable. The next control return
    // is now the target AcceptResult handler boundary.
    const controlReturnReleasePath = resolve(
      fixture.directory,
      "ah10-gates",
      "old-control-return.release",
    );
    expect(relative(resolve(fixture.directory), controlReturnReleasePath)).toBe(
      join("ah10-gates", "old-control-return.release"),
    );
    expect(existsSync(controlReturnReleasePath)).toBe(true);
    unlinkSync(controlReturnReleasePath);
    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "accept_result" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `committed AcceptResult ActionIntent absent: ${error instanceof Error ? error.message : String(error)}; providerTrace=${JSON.stringify(providerTrace)}; listWorkspaceCalls=${JSON.stringify(listWorkspaceCalls)}; acceptResultCalls=${JSON.stringify(acceptResultCalls)}; events=${JSON.stringify(events)}; oldDaemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (oldAction === undefined) {
      throw new Error("AH10 committed AcceptResult ActionIntent absent");
    }
    expect(listWorkspaceCalls).toHaveLength(1);
    expect(acceptResultCalls).toHaveLength(1);
    expect(acceptResultCalls[0]?.resultRef).toMatch(/^rref_[a-f0-9]{64}$/u);
    releaseGate(fixture, "old", "action-intent");
    const oldControlReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.executionId === oldAction.executionId &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      15_000,
    );
    expect(oldControlReturn).toBeDefined();

    const beforeCrash = readAh10Rows(fixture.databaseFile);
    const acceptanceEvents = beforeCrash.domainEvents.filter(
      (event) =>
        event.project_id === project.projectId &&
        event.event_type === "WorkOutcomeAccepted" &&
        event.aggregate_ref === childWorkId,
    );
    expect(acceptanceEvents).toHaveLength(1);
    const acceptanceReceipt = beforeCrash.commands.filter((command) => {
      return (
        command.resolution === "Committed" &&
        command.result_json !== null &&
        command.command_id === acceptanceEvents[0]?.caused_by_command_id
      );
    });
    expect(acceptanceReceipt).toHaveLength(1);
    const acceptanceResult = JSON.parse(
      acceptanceReceipt[0]?.result_json ?? "{}",
    ) as { acceptanceId?: string; workId?: string };
    expect(acceptanceResult.acceptanceId).toMatch(/^acc_/u);
    expect(beforeCrash.acceptances).toEqual([
      expect.objectContaining({
        acceptance_id: acceptanceResult.acceptanceId,
        project_id: project.projectId,
        work_id: childWorkId,
        target_work_revision: childVerification.targetWorkRevision,
        verification_id: childVerification.verificationId,
      }),
    ]);
    expect(acceptanceResult).toMatchObject({
      workId: childWorkId,
      targetWorkRevision: childVerification.targetWorkRevision,
      verificationId: childVerification.verificationId,
    });
    expect(acceptanceEvents[0]?.caused_by_command_id).toBe(
      acceptanceReceipt[0]?.command_id,
    );
    expect(
      beforeCrash.works.find((work) => work.work_id === childWorkId)?.lifecycle,
    ).toBe("Open");
    expect(beforeCrash.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "accept_result",
        state: "Pending",
      }),
    );
    const acceptObservationRef = beforeCrash.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId,
    )?.observation_source_ref;
    expect(acceptObservationRef).toBeNull();
    const parentExecutionObservations = beforeCrash.actionObservations.filter(
      (observation) =>
        observation.source_ref.startsWith(
          `observation_${oldAction.executionId}_`,
        ),
    );
    expect(parentExecutionObservations).toHaveLength(1);
    expect(parentExecutionObservations[0]?.source_ref).toBe(
      beforeCrash.actions.find(
        (action) =>
          action.execution_id === listActionIntent.executionId &&
          action.logical_action_id === listActionIntent.logicalActionId,
      )?.observation_source_ref,
    );
    expect(acceptResultCalls).toHaveLength(1);
    expect(
      beforeCrash.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);

    const oldLease = beforeCrash.leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(oldLease?.generation).toBe(0);
    expect(Date.parse(oldLease?.expires_at ?? "") - Date.now()).toBeGreaterThan(
      0,
    );
    await fixture.crash();
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).leases.find(
          (lease) => lease.execution_id === oldAction.executionId,
        ),
      (lease) =>
        lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
      35_000,
    );
    const recoveryDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "0",
        ARBOR_AH10_GATE_ACTION_KIND: "accept_result",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const recoveredLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(recoveredLease?.fencingGeneration).toBe(1);
    const recoveredIntent = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "accept_result" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    expect(recoveredIntent?.providerTurnId).toBe(oldAction.providerTurnId);
    expect(recoveredIntent?.logicalActionId).toBe(oldAction.logicalActionId);
    expect(recoveredIntent?.callRef).toBe(oldAction.callRef);
    releaseGate(fixture, "new", "action-intent");
    await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionResultCommit" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    releaseGate(fixture, "new", "action-result");
    await waitForPublic(
      async () =>
        readAh10Rows(fixture.databaseFile).works.find(
          (work) => work.work_id === childWorkId,
        ),
      (work) => work?.lifecycle === "Completed",
      30_000,
    );

    const recovered = readAh10Rows(fixture.databaseFile);
    const recoveredReceipts = recovered.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        acceptanceId?: string;
        workId?: string;
      };
      return (
        command.command_id === acceptanceReceipt[0]?.command_id &&
        result.acceptanceId === acceptanceResult.acceptanceId &&
        result.workId === childWorkId
      );
    });
    expect(recoveredReceipts).toHaveLength(1);
    expect(recoveredReceipts[0]?.command_id).toBe(
      acceptanceReceipt[0]?.command_id,
    );
    expect(recovered.acceptances).toEqual(beforeCrash.acceptances);
    expect(
      recovered.domainEvents.filter(
        (event) =>
          event.project_id === project.projectId &&
          event.event_type === "WorkOutcomeAccepted" &&
          event.aggregate_ref === childWorkId,
      ),
    ).toHaveLength(1);
    expect(
      recovered.works.find((work) => work.work_id === childWorkId)?.lifecycle,
    ).toBe("Completed");
    const appliedAction = recovered.actions.find(
      (action) =>
        action.execution_id === oldAction.executionId &&
        action.logical_action_id === oldAction.logicalActionId &&
        action.action_kind === "accept_result",
    );
    expect(appliedAction).toMatchObject({
      provider_turn_id: oldAction.providerTurnId,
      call_ref: oldAction.callRef,
      state: "Applied",
      observation_source_ref: expect.any(String),
    });
    expect(
      recovered.actionObservations.filter(
        (observation) =>
          observation.source_ref === appliedAction?.observation_source_ref,
      ),
    ).toHaveLength(1);
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === oldAction.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    expect(acceptResultCalls).toHaveLength(1);
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    await recoveryDaemon.crash();
  }, 180_000);
});
