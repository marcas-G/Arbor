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
  readonly callRef?: string;
  readonly actionIndex?: number;
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
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.action_index,
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
        action_index: number;
        call_ref: string;
        action_kind: string;
        state: string;
      }>,
    };
  } finally {
    db.close();
  }
};

describe("AH10 real daemon generation takeover", () => {
  it("records the old fence rejection, then lets the new owner commit once without replaying Provider", async () => {
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
      daemonEnvironment: { ARBOR_AH10_ROLE: "old" },
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
    if (oldLease === undefined) throw new Error("AH10 old lease row is absent");
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
      daemonEnvironment: { ARBOR_AH10_ROLE: "new" },
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

    // Let the still-live generation-0 process attempt its actual canonical
    // command only after the DB lease has advanced to generation 1.
    releaseGate(fixture, "old", "action-intent");
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
    expect(readAh10Rows(fixture.databaseFile).works).toHaveLength(1);

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
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      const result = JSON.parse(command.result_json) as {
        readonly sourceWorkId?: string;
        readonly kind?: string;
      };
      return result.sourceWorkId === sourceWorkId && result.kind === "report";
    });
    expect(rejected).toHaveLength(1);
    expect(committed).toHaveLength(1);
    expect(rejected[0]?.command_id).not.toBe(committed[0]?.command_id);
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
  }, 120_000);
});
