import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { semanticRequestFingerprint } from "../../../packages/application/src/index.js";
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
import { makeWorkProvider } from "../support/work-provider.js";

const fixtures: ProductionFixture[] = [];

const validReceiptResult = () => ({
  messageId: functionalId("msg"),
  state: "Pending",
});

const receiptBytesSnapshot = (db: DatabaseSync, commandId: string): unknown =>
  db
    .prepare(
      `SELECT command_id, hex(CAST(command_id AS BLOB)) AS command_id_bytes,
              project_id, hex(CAST(project_id AS BLOB)) AS project_id_bytes,
              semantic_request_fingerprint,
              hex(CAST(semantic_request_fingerprint AS BLOB)) AS fingerprint_bytes,
              schema_version, hex(CAST(schema_version AS BLOB)) AS schema_bytes,
              fingerprint_algorithm_version, resolution, result_json,
              hex(CAST(result_json AS BLOB)) AS result_bytes,
              terminal_error_json, created_at,
              hex(CAST(created_at AS BLOB)) AS created_at_bytes,
              settled_at, hex(CAST(settled_at AS BLOB)) AS settled_at_bytes
         FROM commands WHERE command_id = ?`,
    )
    .get(commandId);

const seedHistoricalReceipt = (
  db: DatabaseSync,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly payload: unknown;
  },
): void => {
  const timestamp = "2026-10-01T00:00:00.000Z";
  const fingerprint = semanticRequestFingerprint({
    commandType: "SubmitHumanMessage",
    projectId: input.projectId,
    actor: input.actor,
    schemaVersion: "1",
    payload: input.payload,
  });
  db.prepare(
    `INSERT INTO commands (
       command_id, project_id, semantic_request_fingerprint, schema_version,
       fingerprint_algorithm_version, resolution, result_json,
       terminal_error_json, created_at, settled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.commandId,
    input.projectId,
    fingerprint,
    "1",
    1,
    "Committed",
    JSON.stringify(validReceiptResult()),
    timestamp,
    timestamp,
  );
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("F23 external command input validation", () => {
  it("rejects a malformed typed MessageId before writing canonical state", async () => {
    const fixture = await startProductionFixture({
      reply: () => ({ _tag: "Text", text: "No model call expected" }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 malformed command identity",
    );

    const commandId = functionalId("cmd");
    const response = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify({
        commandType: "SubmitHumanMessage",
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        issuedAt: new Date().toISOString(),
        payload: {
          messageId: "msg_not-a-uuid-v7",
          targetWorkspaceId: project.rootWorkspaceId,
          bodyRef: "Malformed identity must not enter the journal",
        },
      }),
    });
    const result = (await response.json()) as {
      readonly ok: boolean;
      readonly problem?: {
        readonly code: string;
        readonly message: string;
        readonly safeDetails: {
          readonly commandType?: string;
          readonly issues: ReadonlyArray<{
            readonly path: ReadonlyArray<string | number>;
            readonly rule: string;
          }>;
        };
      };
    };
    expect(response.status).toBe(400);
    expect(result).toMatchObject({
      ok: false,
      problem: {
        code: "InvalidCommandPayload",
        message: "Command payload is invalid",
        safeDetails: {
          commandType: "SubmitHumanMessage",
          issues: [{ path: ["payload", "messageId"], rule: "format" }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("msg_not-a-uuid-v7");
    const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT command_id FROM commands WHERE command_id = ?")
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT command_id FROM command_attempts WHERE command_id = ?",
          )
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT event_id FROM domain_events WHERE caused_by_command_id = ?",
          )
          .all(commandId),
      ).toEqual([]);
    } finally {
      db.close();
    }
    const transcript = await client.view<{
      entries: Array<{ body?: string }>;
    }>("transcript", {
      workspaceId: project.rootWorkspaceId,
      conversationOnly: true,
      limit: 20,
    });
    expect(
      transcript.entries.some((entry) =>
        entry.body?.includes("Malformed identity must not enter the journal"),
      ),
    ).toBe(false);
    expect(fixture.daemonErrors).toEqual([]);
  }, 45_000);

  it("rejects an acp_ ID at the public acceptance boundary", async () => {
    const marker = `F23-ACCEPT-${crypto.randomUUID().slice(0, 8)}`;
    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      reply: makeWorkProvider({ marker, verdict: "Pass" }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 invalid AcceptanceId",
      { resourceSelection: "Profile" },
    );
    await submitHumanMessage(client, project, `请完成目标 ${marker}。`);
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "F23 exact approval",
    });
    const work = await waitForPublic(
      () =>
        client.view<{ workId?: string } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (value) => value?.workId !== undefined,
    );
    if (work?.workId === undefined) throw new Error("approved Work missing");
    const verification = await waitForPublic(
      () =>
        client.view<{
          verificationId?: string;
          targetWorkRevision?: number;
          verdict?: string;
        }>("verification", { workId: work.workId }),
      (value) => value.verificationId !== undefined && value.verdict === "Pass",
      45_000,
    );

    if (
      verification.targetWorkRevision === undefined ||
      verification.verificationId === undefined
    ) {
      throw new Error("passing Verification bindings missing");
    }
    const commandId = functionalId("cmd");
    const acceptanceId = functionalId("acp");
    const response = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify({
        commandType: "AcceptWorkOutcome",
        commandId,
        projectId: project.projectId,
        actor: "user:local",
        issuedAt: new Date().toISOString(),
        payload: {
          acceptanceId,
          workId: work.workId,
          targetWorkRevision: verification.targetWorkRevision,
          verificationId: verification.verificationId,
        },
      }),
    });
    const result = (await response.json()) as {
      readonly ok: boolean;
      readonly status: number;
      readonly problem: {
        readonly code: string;
        readonly category: string;
        readonly message: string;
        readonly correlationId: string | null;
        readonly retryDisposition: string;
        readonly safeDetails: Readonly<Record<string, unknown>>;
      };
    };
    expect(response.status).toBe(400);
    expect(result).toEqual({
      ok: false,
      status: 400,
      problem: {
        code: "InvalidCommandPayload",
        category: "validation",
        message: "Command payload is invalid",
        correlationId: null,
        retryDisposition: "non-retryable",
        safeDetails: {
          commandType: "AcceptWorkOutcome",
          issues: [{ path: ["payload", "acceptanceId"], rule: "format" }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(acceptanceId);
    const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT command_id FROM commands WHERE command_id = ?")
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT command_id FROM command_attempts WHERE command_id = ?",
          )
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT event_id FROM domain_events WHERE caused_by_command_id = ?",
          )
          .all(commandId),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT acceptance_id FROM work_acceptances WHERE acceptance_id = ?",
          )
          .all(acceptanceId),
      ).toEqual([]);
    } finally {
      db.close();
    }
    const unchanged = await client.view<{
      acceptance?: { acceptanceId: string };
    }>("verification", { workId: work.workId });
    expect(unchanged.acceptance).toBeUndefined();
    expect(
      await client.view<{ workId?: string; status: string } | null>(
        "current-work",
        { workspaceId: project.rootWorkspaceId },
      ),
    ).toMatchObject({ workId: work.workId, status: "Open" });
    expect(fixture.daemonErrors).toEqual([]);
  }, 70_000);

  it("preserves legal historical receipts and never replays malformed IDs or payloads", async () => {
    const fixture = await startProductionFixture({
      reply: () => ({ _tag: "Text", text: "No model call expected" }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 historical receipt non-replay",
    );
    const actor = "user:local";
    const invalidCommandId = "cmd_legacy-not-a-uuid-v7";
    const malformedPayloadCommandId = functionalId("cmd");
    const invalidCommandPayload = {
      messageId: functionalId("msg"),
      targetWorkspaceId: project.rootWorkspaceId,
      bodyRef: "legacy command ID receipt must not replay",
    };
    const malformedPayload = {
      messageId: "msg_not-a-uuid-v7",
      targetWorkspaceId: project.rootWorkspaceId,
      bodyRef: "legacy malformed payload receipt must not replay",
    };
    const db = new DatabaseSync(fixture.databaseFile);
    try {
      seedHistoricalReceipt(db, {
        commandId: invalidCommandId,
        projectId: project.projectId,
        actor,
        payload: invalidCommandPayload,
      });
      seedHistoricalReceipt(db, {
        commandId: malformedPayloadCommandId,
        projectId: project.projectId,
        actor,
        payload: malformedPayload,
      });

      const receiptBefore = new Map(
        [invalidCommandId, malformedPayloadCommandId].map((commandId) => [
          commandId,
          receiptBytesSnapshot(db, commandId),
        ]),
      );
      for (const row of receiptBefore.values()) {
        expect(row).toMatchObject({
          resolution: "Committed",
          result_json: expect.any(String),
          terminal_error_json: null,
        });
        const resultJson = JSON.parse(
          (row as { readonly result_json: string }).result_json,
        ) as { readonly messageId: string; readonly state: string };
        expect(resultJson).toMatchObject({ state: "Pending" });
        expect(resultJson.messageId).toMatch(
          /^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/iu,
        );
      }
      const attemptsBefore = db
        .prepare(
          "SELECT command_id, attempt_no, outcome, failure_kind, metadata_json FROM command_attempts WHERE command_id IN (?, ?) ORDER BY command_id, attempt_no",
        )
        .all(invalidCommandId, malformedPayloadCommandId);
      const eventsBefore = db
        .prepare(
          "SELECT event_id, event_type, payload_json FROM domain_events WHERE caused_by_command_id IN (?, ?) ORDER BY caused_by_command_id, event_id",
        )
        .all(invalidCommandId, malformedPayloadCommandId);

      const invalidCommandResponse = await fetch(
        `${fixture.baseUrl}/commands`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer local",
          },
          body: JSON.stringify({
            commandType: "SubmitHumanMessage",
            commandId: invalidCommandId,
            projectId: project.projectId,
            actor,
            issuedAt: new Date().toISOString(),
            payload: invalidCommandPayload,
          }),
        },
      );
      const invalidCommandResult = (await invalidCommandResponse.json()) as {
        readonly ok: boolean;
        readonly status: number;
        readonly problem?: {
          readonly code: string;
          readonly category: string;
          readonly message: string;
          readonly correlationId: string | null;
          readonly retryDisposition: string;
          readonly safeDetails: {
            readonly commandType?: string;
            readonly issues: ReadonlyArray<{
              readonly path: ReadonlyArray<string | number>;
              readonly rule: string;
            }>;
          };
        };
      };
      expect(invalidCommandResponse.status).toBe(400);
      expect(invalidCommandResult).toEqual({
        ok: false,
        status: 400,
        problem: {
          code: "InvalidCommandPayload",
          category: "validation",
          message: "Command payload is invalid",
          correlationId: null,
          retryDisposition: "non-retryable",
          safeDetails: {
            commandType: "SubmitHumanMessage",
            issues: [{ path: ["commandId"], rule: "format" }],
          },
        },
      });
      expect(JSON.stringify(invalidCommandResult)).not.toContain(
        invalidCommandId,
      );
      const invalidCommandReceipt = receiptBefore.get(invalidCommandId) as {
        readonly semantic_request_fingerprint: string;
        readonly result_json: string;
      };
      expect(JSON.stringify(invalidCommandResult)).not.toContain(
        invalidCommandReceipt.semantic_request_fingerprint,
      );
      expect(JSON.stringify(invalidCommandResult)).not.toContain(
        invalidCommandReceipt.result_json,
      );
      expect(JSON.stringify(invalidCommandResult)).not.toContain(
        (JSON.parse(invalidCommandReceipt.result_json) as { messageId: string })
          .messageId,
      );

      const malformedPayloadResponse = await fetch(
        `${fixture.baseUrl}/commands`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer local",
          },
          body: JSON.stringify({
            commandType: "SubmitHumanMessage",
            commandId: malformedPayloadCommandId,
            projectId: project.projectId,
            actor,
            issuedAt: new Date().toISOString(),
            payload: malformedPayload,
          }),
        },
      );
      const malformedPayloadResult =
        (await malformedPayloadResponse.json()) as {
          readonly ok: boolean;
          readonly status: number;
          readonly problem?: {
            readonly code: string;
            readonly category: string;
            readonly message: string;
            readonly correlationId: string | null;
            readonly retryDisposition: string;
            readonly safeDetails: {
              readonly commandType?: string;
              readonly issues: ReadonlyArray<{
                readonly path: ReadonlyArray<string | number>;
                readonly rule: string;
              }>;
            };
          };
        };
      expect(malformedPayloadResponse.status).toBe(400);
      expect(malformedPayloadResult).toEqual({
        ok: false,
        status: 400,
        problem: {
          code: "InvalidCommandPayload",
          category: "validation",
          message: "Command payload is invalid",
          correlationId: null,
          retryDisposition: "non-retryable",
          safeDetails: {
            commandType: "SubmitHumanMessage",
            issues: [{ path: ["payload", "messageId"], rule: "format" }],
          },
        },
      });
      expect(JSON.stringify(malformedPayloadResult)).not.toContain(
        "msg_not-a-uuid-v7",
      );
      const malformedPayloadReceipt = receiptBefore.get(
        malformedPayloadCommandId,
      ) as {
        readonly semantic_request_fingerprint: string;
        readonly result_json: string;
      };
      expect(JSON.stringify(malformedPayloadResult)).not.toContain(
        malformedPayloadReceipt.semantic_request_fingerprint,
      );
      expect(JSON.stringify(malformedPayloadResult)).not.toContain(
        malformedPayloadReceipt.result_json,
      );
      expect(JSON.stringify(malformedPayloadResult)).not.toContain(
        (
          JSON.parse(malformedPayloadReceipt.result_json) as {
            messageId: string;
          }
        ).messageId,
      );

      expect(
        [invalidCommandId, malformedPayloadCommandId].map((commandId) => [
          commandId,
          receiptBytesSnapshot(db, commandId),
        ]),
      ).toEqual([...receiptBefore]);
      expect(
        db
          .prepare(
            "SELECT command_id, attempt_no, outcome, failure_kind, metadata_json FROM command_attempts WHERE command_id IN (?, ?) ORDER BY command_id, attempt_no",
          )
          .all(invalidCommandId, malformedPayloadCommandId),
      ).toEqual(attemptsBefore);
      expect(
        db
          .prepare(
            "SELECT event_id, event_type, payload_json FROM domain_events WHERE caused_by_command_id IN (?, ?) ORDER BY caused_by_command_id, event_id",
          )
          .all(invalidCommandId, malformedPayloadCommandId),
      ).toEqual(eventsBefore);
      expect(fixture.daemonErrors).toEqual([]);
    } finally {
      db.close();
    }
  }, 45_000);
});
