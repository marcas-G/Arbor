import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AhProbeHit } from "../support/ah-probe-line.js";
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

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const readPromotionSnapshot = (
  databaseFile: string,
  workspaceId: string,
  entryKey: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const messages = db
      .prepare(
        "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind FROM messages ORDER BY message_id",
      )
      .all() as Array<{
      message_id: string;
      sender_workspace_id: string;
      recipient_workspace_id: string;
      kind: string;
    }>;
    const inbox = db
      .prepare(
        "SELECT workspace_id, entry_key, kind, summary, consumed_at FROM inbox_entries WHERE workspace_id = ? AND kind = 'Message' ORDER BY entry_key",
      )
      .all(workspaceId) as Array<{
      workspace_id: string;
      entry_key: string;
      kind: string;
      summary: string;
      consumed_at: string | null;
    }>;
    const episode = db
      .prepare(
        `SELECT e.execution_id, e.session_id, e.episode_ref
           FROM executions e
          WHERE e.episode_kind = 'InboxEpisode'
            AND e.workspace_id = ?
            AND e.episode_ref = ?`,
      )
      .all(workspaceId, entryKey) as Array<{
      execution_id: string;
      session_id: string;
      episode_ref: string;
    }>;
    const inboxExecutionId = episode[0]?.execution_id;
    const providerTurns =
      inboxExecutionId === undefined
        ? []
        : (db
            .prepare(
              `SELECT provider_turn_id, execution_id, context_epoch, settled_at,
                      finish_reason
                 FROM provider_turns WHERE execution_id = ?
                ORDER BY provider_turn_id`,
            )
            .all(inboxExecutionId) as Array<{
            provider_turn_id: string;
            execution_id: string;
            context_epoch: number;
            settled_at: string | null;
            finish_reason: string | null;
          }>);
    const providerAttempts =
      inboxExecutionId === undefined
        ? []
        : (db
            .prepare(
              `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome
                 FROM provider_attempts pa
                 JOIN provider_turns pt
                   ON pt.provider_turn_id = pa.provider_turn_id
                WHERE pt.execution_id = ?
                ORDER BY pa.provider_turn_id, pa.attempt_no`,
            )
            .all(inboxExecutionId) as Array<{
            provider_turn_id: string;
            attempt_no: number;
            outcome: string;
          }>);
    const sessionInputs = db
      .prepare(
        `SELECT session_id, sequence, item_type, source_kind, source_ref, payload_json
           FROM session_entries
          WHERE item_type = 'UserMessage' AND source_kind = 'InboxEntry'
          ORDER BY session_id, sequence`,
      )
      .all() as Array<{
      session_id: string;
      sequence: number;
      item_type: string;
      source_kind: string;
      source_ref: string;
      payload_json: string;
    }>;
    const messageEvents = db
      .prepare(
        "SELECT aggregate_ref, event_type FROM domain_events WHERE event_type = 'MessageSent' ORDER BY sequence",
      )
      .all() as Array<{ aggregate_ref: string; event_type: string }>;
    const targetInbox = inbox.filter((entry) => entry.entry_key === entryKey);
    const targetMessageIds = new Set(
      targetInbox.flatMap((entry) =>
        entry.entry_key.startsWith("msg:")
          ? [entry.entry_key.slice("msg:".length)]
          : [],
      ),
    );
    const targetEntryKeys = new Set(
      targetInbox.map((entry) => entry.entry_key),
    );
    const result = {
      messages: messages.filter((message) =>
        targetMessageIds.has(message.message_id),
      ),
      inbox: targetInbox,
      episode,
      providerTurns,
      providerAttempts,
      sessionInputs: sessionInputs.filter((item) =>
        targetEntryKeys.has(item.source_ref),
      ),
      messageEvents: messageEvents.filter((event) =>
        targetMessageIds.has(event.aggregate_ref),
      ),
    };
    db.exec("ROLLBACK");
    return result;
  } finally {
    db.close();
  }
};

interface Ah15ProbeHit extends AhProbeHit {
  readonly entryKey?: string;
}

const recordProbe = (hits: Ah15ProbeHit[], line: string) => {
  try {
    const event = JSON.parse(line) as Ah15ProbeHit & {
      readonly tag?: string;
    };
    if (event.tag === "AH_PROBE") hits.push(event);
  } catch {
    // Keep daemon output available through the fixture for failure diagnostics.
  }
};

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
  },
});

describe("AH15 Inbox input promotion process crash", () => {
  for (const boundary of [
    "AH15BeforeInboxPromotionCommit",
    "AH15AfterInboxPromotionCommit",
  ] as const) {
    it(`recovers one MessageId after killing the daemon at ${boundary}`, async () => {
      const childMarker = `AH15-CHILD-${crypto.randomUUID().slice(0, 8)}`;
      const messageMarker = `AH15-MESSAGE-${crypto.randomUUID().slice(0, 8)}`;
      const hits: Ah15ProbeHit[] = [];
      let childDecisionRequests = 0;
      let childInitialDecisionRequests = 0;
      let childActionIssued = false;
      let parentWorkspaceId = "";
      let senderWorkspaceId = "";
      const fixture = await startProductionFixture({
        reply: (call) => {
          const context = JSON.stringify(call.messages);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (
            context.includes(childMarker) &&
            !call.messages.some((message) => message.role === "tool")
          ) {
            childInitialDecisionRequests += 1;
          }
          if (
            context.includes(childMarker) &&
            available.has("send_message") &&
            !childActionIssued
          ) {
            childDecisionRequests += 1;
            childActionIssued = true;
            return {
              _tag: "ToolCall",
              name: "send_message",
              arguments: {
                kind: "Query",
                body: `Please receive ${messageMarker}.`,
                recipientWorkspaceId: parentWorkspaceId,
              },
            };
          }
          if (
            senderWorkspaceId.length > 0 &&
            context.includes(`Query from ${senderWorkspaceId}`)
          ) {
            return {
              _tag: "Text",
              text: `Received AH15 Inbox ${messageMarker}`,
            };
          }
          return manualWait(`wait after AH15 ${messageMarker}`);
        },
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        onDaemonStdout: (line) => recordProbe(hits, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH15 inbox promotion ${messageMarker}`,
      );
      parentWorkspaceId = project.rootWorkspaceId;
      const childWorkspaceId = functionalId("ws");
      senderWorkspaceId = childWorkspaceId;
      const childSessionId = functionalId("ses");
      const childWorkId = functionalId("wrk");
      const childDirectory = resolve(
        fixture.directory,
        `child-${messageMarker}`,
      );
      mkdirSync(childDirectory, { recursive: true });
      await client.command(project.projectId, "CreateChildWorkspace", {
        parentWorkspaceId: project.rootWorkspaceId,
        workspaceId: childWorkspaceId,
        primarySession: { sessionId: childSessionId, contextEpoch: 0 },
        name: `child-${messageMarker}`,
        responsibilityDefinition: {
          purpose: `send one Query containing ${messageMarker}`,
          ownedResponsibilities: [messageMarker],
          obligations: [`send one message ${messageMarker}`],
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
        objective: `For ${childMarker}, send one Query to the parent containing ${messageMarker}.`,
        why: "qualify Inbox append/consume recovery across daemon restart",
        constraints: ["send exactly one Query"],
        completionExpectation:
          "the parent Inbox promotes the Query exactly once",
        verificationMission: {
          goal: `Verify exact Inbox promotion for ${messageMarker}`,
          criteria: [
            {
              criterionId: "ah15-single-promotion",
              requirement: "the exact MessageId is promoted once and consumed",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "AH15 process fixture" },
        revision: 0,
      });

      const hit = await waitForPublic(
        async () => hits.find((candidate) => candidate.boundary === boundary),
        (candidate) => candidate !== undefined,
        30_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH15 probe absent at ${boundary}: ${error instanceof Error ? error.message : String(error)}; childActionOutputs=${childDecisionRequests}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-4).map((call) => ({ roles: call.messages.map((message) => message.role), messageMarker: JSON.stringify(call.messages).includes(messageMarker), childMarker: JSON.stringify(call.messages).includes(childMarker), tools: call.tools.map((tool) => tool.function?.name) })))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (hit === undefined) {
        throw new Error(
          `AH15 probe absent at ${boundary}; childDecisionRequests=${childDecisionRequests}; calls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      expect(hit.executionId).toMatch(/^exe_/u);
      expect(hit.entryKey).toMatch(/^msg:/u);
      if (hit.entryKey === undefined) throw new Error("AH15 entry key absent");
      const entryKey = hit.entryKey;
      const beforeKill = readPromotionSnapshot(
        fixture.databaseFile,
        project.rootWorkspaceId,
        entryKey,
      );
      expect(beforeKill.messages).toHaveLength(1);
      expect(beforeKill.messageEvents).toEqual([
        {
          aggregate_ref: beforeKill.messages[0]?.message_id,
          event_type: "MessageSent",
        },
      ]);
      const messageId = beforeKill.messages[0]?.message_id;
      if (messageId === undefined) throw new Error("AH15 MessageId is absent");
      expect(entryKey).toBe(`msg:${messageId}`);
      expect(beforeKill.messages[0]).toMatchObject({
        sender_workspace_id: childWorkspaceId,
        recipient_workspace_id: project.rootWorkspaceId,
        kind: "Query",
      });
      expect(beforeKill.inbox).toEqual([
        expect.objectContaining({
          workspace_id: project.rootWorkspaceId,
          entry_key: entryKey,
          kind: "Message",
        }),
      ]);
      expect(beforeKill.episode).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          episode_ref: entryKey,
        }),
      ]);
      expect(beforeKill.providerTurns).toEqual([]);
      expect(beforeKill.providerAttempts).toEqual([]);
      if (boundary === "AH15BeforeInboxPromotionCommit") {
        expect(beforeKill.inbox[0]?.consumed_at).toBeNull();
        expect(
          beforeKill.sessionInputs.filter(
            (input) => input.session_id === beforeKill.episode[0]?.session_id,
          ),
        ).toEqual([]);
      } else {
        expect(beforeKill.inbox[0]?.consumed_at).not.toBeNull();
        expect(beforeKill.sessionInputs).toEqual([
          expect.objectContaining({
            session_id: beforeKill.episode[0]?.session_id,
            item_type: "UserMessage",
            source_kind: "InboxEntry",
            source_ref: entryKey,
          }),
        ]);
      }

      await fixture.crash();
      const afterKill = readPromotionSnapshot(
        fixture.databaseFile,
        project.rootWorkspaceId,
        entryKey,
      );
      expect(afterKill.messages).toHaveLength(1);
      expect(afterKill.providerTurns).toEqual([]);
      expect(afterKill.providerAttempts).toEqual([]);
      if (boundary === "AH15BeforeInboxPromotionCommit") {
        expect(afterKill.inbox[0]?.consumed_at).toBeNull();
        expect(
          afterKill.sessionInputs.filter(
            (input) => input.session_id === afterKill.episode[0]?.session_id,
          ),
        ).toEqual([]);
      } else {
        expect(afterKill.inbox[0]?.consumed_at).not.toBeNull();
        expect(afterKill.sessionInputs).toHaveLength(1);
      }

      await fixture.restart();
      await waitForPublic(
        async () =>
          readPromotionSnapshot(
            fixture.databaseFile,
            project.rootWorkspaceId,
            entryKey,
          ),
        (snapshot) =>
          snapshot.inbox[0]?.consumed_at !== null &&
          snapshot.sessionInputs.some(
            (input) =>
              input.session_id === snapshot.episode[0]?.session_id &&
              input.source_ref === entryKey,
          ) &&
          snapshot.providerTurns.length === 1 &&
          snapshot.providerTurns[0]?.settled_at !== null &&
          snapshot.providerAttempts.length === 1 &&
          snapshot.providerAttempts[0]?.outcome === "Success" &&
          fixture.providerCalls.some((call) =>
            JSON.stringify(call.messages).includes(
              `Query from ${childWorkspaceId}`,
            ),
          ),
        45_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH15 parent Inbox Provider did not settle once after restart: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readPromotionSnapshot(fixture.databaseFile, project.rootWorkspaceId, entryKey))}; providerCalls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      const recovered = readPromotionSnapshot(
        fixture.databaseFile,
        project.rootWorkspaceId,
        entryKey,
      );
      expect(recovered.messages).toHaveLength(1);
      expect(recovered.messages[0]?.message_id).toBe(messageId);
      expect(recovered.messageEvents).toEqual([
        { aggregate_ref: messageId, event_type: "MessageSent" },
      ]);
      expect(recovered.inbox).toEqual([
        expect.objectContaining({
          entry_key: entryKey,
          consumed_at: expect.any(String),
        }),
      ]);
      expect(recovered.sessionInputs).toEqual([
        expect.objectContaining({
          session_id: recovered.episode[0]?.session_id,
          item_type: "UserMessage",
          source_kind: "InboxEntry",
          source_ref: entryKey,
          payload_json: expect.stringContaining(entryKey),
        }),
      ]);
      expect(recovered.episode).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          session_id: beforeKill.episode[0]?.session_id,
          episode_ref: entryKey,
        }),
      ]);
      expect(recovered.providerTurns).toHaveLength(1);
      expect(recovered.providerTurns[0]).toMatchObject({
        execution_id: hit.executionId,
        context_epoch: 0,
        settled_at: expect.any(String),
      });
      expect(recovered.providerAttempts).toEqual([
        expect.objectContaining({
          provider_turn_id: recovered.providerTurns[0]?.provider_turn_id,
          attempt_no: 0,
          outcome: "Success",
        }),
      ]);
      expect(childDecisionRequests).toBe(1);
      expect(childInitialDecisionRequests).toBe(1);
      expect(
        fixture.providerCalls.filter((call) =>
          JSON.stringify(call.messages).includes(
            `Query from ${childWorkspaceId}`,
          ),
        ),
      ).toHaveLength(1);
      expect(fixture.daemonErrors).toEqual([]);
    }, 90_000);
  }
});
