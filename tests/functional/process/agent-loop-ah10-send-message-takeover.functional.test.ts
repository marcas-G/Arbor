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
  readonly actionKind?: string;
  readonly callRef?: string;
  readonly actionIndex?: number;
}

interface CommandRow {
  readonly command_id: string;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
}

interface MessageRow {
  readonly message_id: string;
  readonly sender_workspace_id: string;
  readonly recipient_workspace_id: string;
  readonly kind: string;
  readonly body_ref: string;
  readonly correlation_id: string | null;
}

interface InboxRow {
  readonly workspace_id: string;
  readonly entry_key: string;
  readonly kind: string;
  readonly summary: string;
  readonly correlation_id: string | null;
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

const readRows = (databaseFile: string) => {
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
        .all() as unknown as CommandRow[],
      messages: db
        .prepare(
          "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id FROM messages ORDER BY message_id",
        )
        .all() as unknown as MessageRow[],
      inbox: db
        .prepare(
          "SELECT workspace_id, entry_key, kind, summary, correlation_id FROM inbox_entries WHERE kind = 'Message' ORDER BY entry_key",
        )
        .all() as unknown as InboxRow[],
      actions: db
        .prepare(
          `SELECT a.execution_id, s.provider_turn_id, a.logical_action_id,
                  a.action_index, a.observation_source_ref, a.call_ref,
                  a.action_kind, a.state
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
      observations: db
        .prepare(
          `SELECT se.source_ref, se.payload_json
             FROM session_entries se
            WHERE se.source_kind = 'AgentLoopAction'
              AND se.entry_kind = 'Observation'
            ORDER BY se.sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
    };
  } finally {
    db.close();
  }
};

describe("AH10 real daemon SendMessage generation takeover", () => {
  it("takes over a Query after gen0 FencingRejected and admits one canonical Message", async () => {
    const marker = `AH10-send-query-${crypto.randomUUID().slice(0, 8)}`;
    const events: Ah10Probe[] = [];
    const providerMarkerCalls: number[] = [];
    const fixture = await startProductionFixture({
      reply: (call, index) => {
        const context = JSON.stringify(call.messages);
        if (!context.includes(marker))
          return { _tag: "HttpError", status: 422 };
        providerMarkerCalls.push(index);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (!available.has("send_message")) {
          return { _tag: "HttpError", status: 422 };
        }
        return {
          _tag: "ToolCall",
          name: "send_message",
          arguments: {
            kind: "Query",
            body: `Please report the status for ${marker}.`,
            recipientWorkspaceId: project.rootWorkspaceId,
          },
        };
      },
      firstDaemonEntry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_GATE_ACTION_KIND: "send_message",
        ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT: "0",
      },
      onDaemonStdout: (line) => pushProbe(events, line),
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 SendMessage generation takeover",
    );
    const childWorkspaceId = functionalId("ws");
    const childSessionId = functionalId("ses");
    const childWorkId = functionalId("wrk");
    const childDirectory = resolve(fixture.directory, `child-${marker}`);
    mkdirSync(childDirectory, { recursive: true });
    await client.command(project.projectId, "CreateChildWorkspace", {
      parentWorkspaceId: project.rootWorkspaceId,
      workspaceId: childWorkspaceId,
      primarySession: { sessionId: childSessionId, contextEpoch: 0 },
      name: `child-${marker}`,
      responsibilityDefinition: {
        purpose: `send a status Query for ${marker}`,
        ownedResponsibilities: [marker],
        obligations: ["send one durable Query to the parent"],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceBoundary: {
        basisResponsibilityRevision: 0,
        addresses: [{ _tag: "FileTree", path: childDirectory }],
      },
      resourceBoundaryRevision: 0,
      agentBinding: {
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: childWorkspaceId,
      },
      workspacePolicy: {},
      workspacePolicyRevision: 0,
      revision: 0,
    });
    await client.command(project.projectId, "AssignWork", {
      workId: childWorkId,
      workspaceId: childWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: `Send the parent a status Query for ${marker}.`,
      why: "qualify durable SendMessage ownership across daemon generations",
      constraints: ["send exactly one Query to the parent"],
      completionExpectation: "one Query is admitted to the parent Inbox",
      verificationMission: {
        goal: `Verify one status Query for ${marker}`,
        criteria: [
          {
            criterionId: "ah10-send-query-admitted",
            requirement: "one exact Query is present in the parent Inbox",
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
            event.actionKind === "send_message" &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (oldAction === undefined) {
      throw new Error("AH10 old SendMessage ActionIntent probe was absent");
    }
    expect(oldAction.callRef).toMatch(/^call_/u);
    expect(oldAction.providerTurnId).toMatch(/^ptn_/u);
    expect(oldAction.logicalActionId).toMatch(/^lac_/u);

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
    if (oldLeasePause === undefined) {
      throw new Error("AH10 old lease renewal pause probe was absent");
    }
    expect(oldLeasePause.fencingGeneration).toBe(0);
    const oldLease = readRows(fixture.databaseFile).leases.find(
      (lease) => lease.execution_id === oldAction.executionId,
    );
    expect(oldLease?.generation).toBe(0);
    await waitForPublic(
      async () =>
        readRows(fixture.databaseFile).leases.find(
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
        ARBOR_AH10_GATE_ACTION_KIND: "send_message",
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
    if (newLease === undefined) {
      throw new Error("AH10 new SendMessage owner did not acquire the lease");
    }
    expect(newLease.fencingGeneration).toBe(1);
    const newAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "send_message" &&
            event.executionId === oldAction.executionId &&
            event.actionIndex === 0,
        ),
      (event) => event !== undefined,
      30_000,
    );
    if (newAction === undefined) {
      throw new Error("AH10 new SendMessage ActionIntent probe was absent");
    }
    expect(newAction.providerTurnId).toBe(oldAction.providerTurnId);
    expect(newAction.callRef).toBe(oldAction.callRef);
    expect(newAction.logicalActionId).toBe(oldAction.logicalActionId);

    releaseGate(fixture, "old", "action-intent");
    const fenced = await waitForPublic(
      async () =>
        readRows(fixture.databaseFile).commands.filter(
          (command) =>
            command.resolution === "TerminalRejected" &&
            command.terminal_error_json?.includes("FencingRejected"),
        ),
      (commands) => commands.length === 1,
      15_000,
    );
    expect(fenced).toHaveLength(1);
    expect(readRows(fixture.databaseFile).messages).toHaveLength(0);
    await fixture.crash();

    releaseGate(fixture, "new", "action-intent");
    const completed = await waitForPublic(
      async () => readRows(fixture.databaseFile),
      (rows) =>
        rows.actions.some(
          (action) =>
            action.execution_id === oldAction.executionId &&
            action.logical_action_id === oldAction.logicalActionId &&
            action.state === "Applied",
        ) && rows.messages.length === 1,
      30_000,
    );

    const message = completed.messages[0];
    expect(message).toMatchObject({
      sender_workspace_id: childWorkspaceId,
      recipient_workspace_id: project.rootWorkspaceId,
      kind: "Query",
    });
    expect(message?.body_ref).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.correlation_id).toMatch(/^cor_/u);
    expect(completed.inbox).toEqual([
      expect.objectContaining({
        workspace_id: project.rootWorkspaceId,
        entry_key: `msg:${message?.message_id}`,
        kind: "Message",
        correlation_id: message?.correlation_id,
      }),
    ]);

    const committed = completed.commands.filter((command) => {
      if (command.resolution !== "Committed" || command.result_json === null) {
        return false;
      }
      try {
        return (
          (JSON.parse(command.result_json) as { messageId?: string })
            .messageId === message?.message_id
        );
      } catch {
        return false;
      }
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]?.command_id).not.toBe(fenced[0]?.command_id);
    expect(completed.actions).toContainEqual(
      expect.objectContaining({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_action_id: oldAction.logicalActionId,
        call_ref: oldAction.callRef,
        action_kind: "send_message",
        state: "Applied",
      }),
    );
    expect(completed.observations).toHaveLength(1);
    expect(fixture.providerCalls).toHaveLength(1);
    expect(providerMarkerCalls).toHaveLength(1);
    expect(newDaemon.daemonErrors).toEqual([]);
  }, 90_000);
});
