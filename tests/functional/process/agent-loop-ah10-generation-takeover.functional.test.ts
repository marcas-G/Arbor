import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  waitForPublic,
} from "../support/public-client.js";

interface Ah10Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly fencingGeneration?: number;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
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

const fixtures: ProductionFixture[] = [];
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
        .prepare("SELECT work_id, objective FROM works ORDER BY created_at")
        .all() as Array<{ work_id: string; objective: string }>,
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
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.action_index,
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
        call_ref: string;
        action_kind: string;
        state: string;
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
      const fixture = await startProductionFixture({
        reply: (call, index) => {
          if (JSON.stringify(call.messages).includes(marker)) {
            providerMarkerCalls.push(`provider-call-${index}`);
          }
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (!available.has("produce_deliverable")) {
            return { _tag: "HttpError", status: 422 };
          }
          return {
            _tag: "ToolCall",
            name: "produce_deliverable",
            arguments: {
              kind: "report",
              artifacts: [],
            },
          };
        },
        firstDaemonEntry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
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
      const sourceWorkId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId: sourceWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: `Exercise AH10 takeover ${marker}.`,
        why: "qualify old owner fencing and new owner receipt lookup",
        constraints: [],
        completionExpectation: "the pinned action commits one Deliverable",
        verificationMission: {
          goal: `Verify AH10 source Work ${marker}`,
          criteria: [
            {
              criterionId: "ah10-source-open",
              requirement: "the source Work remains open during takeover",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "AH10 process fixture" },
        revision: 0,
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
      expect(fixture.providerCalls).toHaveLength(1);
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
    const fixture = await startProductionFixture({
      reply: (call) => {
        if (JSON.stringify(call.messages).includes(marker)) {
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          return available.has("produce_deliverable")
            ? {
                _tag: "ToolCall",
                name: "produce_deliverable",
                arguments: { kind: "report", artifacts: [] },
              }
            : { _tag: "HttpError", status: 422 };
        }
        return { _tag: "HttpError", status: 422 };
      },
      firstDaemonEntry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
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
    const sourceWorkId = functionalId("wrk");
    await client.command(project.projectId, "AssignWork", {
      workId: sourceWorkId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: `Exercise pending action takeover ${marker}.`,
      why: "qualify canonical receipt recovery before Action result commit",
      constraints: [],
      completionExpectation: "the pinned action commits one Deliverable",
      verificationMission: {
        goal: `Verify AH10 pending Action ${marker}`,
        criteria: [
          {
            criterionId: "ah10-pending-action",
            requirement: "the source Work remains open during takeover",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "AH10 process fixture" },
      revision: 0,
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
    expect(beforeCrash.actionObservations).toHaveLength(0);
    expect(fixture.providerCalls).toHaveLength(1);

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
    expect(recovered.actionObservations).toHaveLength(1);
    expect(fixture.providerCalls).toHaveLength(1);
    expect(recoveryDaemon.daemonErrors).toEqual([]);
    releaseGate(fixture, "new", "action-result");
    await recoveryDaemon.crash();
  }, 90_000);

  it.each(["before", "after"] as const)(
    "takes over DeclareDependency after killing the old owner %s its FencingRejected receipt commits",
    async (crashSide) => {
      const marker = `AH10-dependency-${crypto.randomUUID().slice(0, 8)}`;
      const dependencyKind = `ah10-dependency-${marker}`;
      const events: Ah10Probe[] = [];
      const providerMarkerCalls: string[] = [];
      const fixture = await startProductionFixture({
        reply: (call, index) => {
          if (!JSON.stringify(call.messages).includes(marker)) {
            return { _tag: "HttpError", status: 422 };
          }
          providerMarkerCalls.push(`provider-call-${index}`);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (!available.has("declare_dependency")) {
            return { _tag: "HttpError", status: 422 };
          }
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
        firstDaemonEntry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "old",
          ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
            crashSide === "before" ? "1" : "0",
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
      const consumerWorkId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId: consumerWorkId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: `Declare dependency ${marker}.`,
        why: "qualify generation-scoped dependency command takeover",
        constraints: [],
        completionExpectation: "one exact dependency is durably declared",
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
        provenance: { predecessorWorkId: null, reason: "AH10 process fixture" },
        revision: 0,
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
      expect(final.actionObservations).toHaveLength(1);
      expect(providerMarkerCalls).toHaveLength(1);
      expect(fixture.providerCalls).toHaveLength(1);
      expect(newDaemon.daemonErrors).toEqual([]);
      expect(fixture.daemonErrors).toEqual([]);
      releaseGate(fixture, "new", "action-result");
      await newDaemon.crash();
    },
    120_000,
  );
});
