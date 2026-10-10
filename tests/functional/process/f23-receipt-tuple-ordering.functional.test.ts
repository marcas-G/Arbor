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
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

const seedCorruptCommittedReceipt = (
  db: DatabaseSync,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly payload: unknown;
    readonly resultJson: string;
  },
) => {
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
     ) VALUES (?, ?, ?, '1', 1, 'Committed', ?, NULL, ?, ?)`,
  ).run(
    input.commandId,
    input.projectId,
    fingerprint,
    input.resultJson,
    "2026-10-10T00:00:00.000Z",
    "2026-10-10T00:00:00.000Z",
  );
  return fingerprint;
};

const receiptBytesSnapshot = (db: DatabaseSync, commandId: string) =>
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

const postExternalHumanMessage = (
  baseUrl: string,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly actor: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
) =>
  fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local",
    },
    body: JSON.stringify({
      commandType: "SubmitHumanMessage",
      commandId: input.commandId,
      projectId: input.projectId,
      actor: input.actor,
      issuedAt: new Date().toISOString(),
      payload: input.payload,
    }),
  });

const sideEffectSnapshot = (db: DatabaseSync, commandId: string) => ({
  attempts: db
    .prepare(
      `SELECT command_id, attempt_no, outcome, failure_kind, metadata_json
         FROM command_attempts WHERE command_id = ? ORDER BY attempt_no`,
    )
    .all(commandId),
  events: db
    .prepare(
      `SELECT event_id, event_type, aggregate_ref, payload_json
         FROM domain_events WHERE caused_by_command_id = ? ORDER BY event_id`,
    )
    .all(commandId),
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("F23 Gateway receipt tuple comparison before stored JSON decode", () => {
  it("returns IdempotencyConflict for a tuple mismatch before parsing corrupt historical JSON", async () => {
    const sentinel = `F23-CORRUPT-RECEIPT-${crypto.randomUUID()}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: () => ({ _tag: "HttpError", status: 500 }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 receipt tuple ordering mismatch",
    );
    const actor = "user:local";
    const commandId = functionalId("cmd");
    const messageId = functionalId("msg");
    const oldPayload = {
      messageId,
      targetWorkspaceId: project.rootWorkspaceId,
      bodyRef: "body-ref-old",
    };
    const currentPayload = {
      ...oldPayload,
      bodyRef: "body-ref-current",
    };
    const rawMalformedResult = `{"messageId":"${messageId}","secret":"${sentinel}`;
    const db = new DatabaseSync(fixture.databaseFile);
    try {
      const oldFingerprint = seedCorruptCommittedReceipt(db, {
        commandId,
        projectId: project.projectId,
        actor,
        payload: oldPayload,
        resultJson: rawMalformedResult,
      });
      const currentFingerprint = semanticRequestFingerprint({
        commandType: "SubmitHumanMessage",
        projectId: project.projectId,
        actor,
        schemaVersion: "1",
        payload: currentPayload,
      });
      expect(oldFingerprint).not.toBe(currentFingerprint);
      const receiptBefore = receiptBytesSnapshot(db, commandId);
      const sideEffectsBefore = sideEffectSnapshot(db, commandId);

      const response = await postExternalHumanMessage(fixture.baseUrl, {
        commandId,
        projectId: project.projectId,
        actor,
        payload: currentPayload,
      });
      const bodyText = await response.text();
      const responseBody = JSON.parse(bodyText) as {
        readonly ok: boolean;
        readonly status: number;
        readonly body?: {
          readonly commandId: string;
          readonly resolution: string;
          readonly rejection?: string;
        };
      };

      expect(response.status).toBe(200);
      expect(responseBody).toMatchObject({
        ok: true,
        status: 200,
        body: {
          commandId,
          resolution: "TerminalRejected",
          rejection: "IdempotencyConflict",
        },
      });
      expect(bodyText).not.toContain(sentinel);
      expect(bodyText).not.toContain(rawMalformedResult);
      expect(bodyText).not.toContain(oldFingerprint);
      expect(receiptBytesSnapshot(db, commandId)).toEqual(receiptBefore);
      expect(sideEffectSnapshot(db, commandId)).toEqual(sideEffectsBefore);
      expect(fixture.daemonErrors).toEqual([]);
    } finally {
      db.close();
    }
  }, 45_000);

  it("fails closed for an exact tuple with corrupt stored JSON without changing the receipt", async () => {
    const sentinel = `F23-EXACT-TUPLE-CORRUPT-${crypto.randomUUID()}`;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: () => ({ _tag: "HttpError", status: 500 }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "F23 exact tuple decode fail closed",
    );
    const actor = "user:local";
    const commandId = functionalId("cmd");
    const payload = {
      messageId: functionalId("msg"),
      targetWorkspaceId: project.rootWorkspaceId,
      bodyRef: "body-ref-exact",
    };
    const rawMalformedResult = `{"messageId":"${payload.messageId}","secret":"${sentinel}`;
    const db = new DatabaseSync(fixture.databaseFile);
    try {
      const storedFingerprint = seedCorruptCommittedReceipt(db, {
        commandId,
        projectId: project.projectId,
        actor,
        payload,
        resultJson: rawMalformedResult,
      });
      const currentFingerprint = semanticRequestFingerprint({
        commandType: "SubmitHumanMessage",
        projectId: project.projectId,
        actor,
        schemaVersion: "1",
        payload,
      });
      expect(storedFingerprint).toBe(currentFingerprint);
      const receiptBefore = receiptBytesSnapshot(db, commandId);
      const sideEffectsBefore = sideEffectSnapshot(db, commandId);

      const response = await postExternalHumanMessage(fixture.baseUrl, {
        commandId,
        projectId: project.projectId,
        actor,
        payload,
      });
      const bodyText = await response.text();

      expect(response.ok).toBe(false);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(600);
      expect(bodyText).not.toContain(sentinel);
      expect(bodyText).not.toContain(rawMalformedResult);
      expect(receiptBytesSnapshot(db, commandId)).toEqual(receiptBefore);
      expect(sideEffectSnapshot(db, commandId)).toEqual(sideEffectsBefore);
      expect(fixture.daemonErrors).toEqual([]);
    } finally {
      db.close();
    }
  }, 45_000);
});
