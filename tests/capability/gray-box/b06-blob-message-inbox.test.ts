import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect } from "vitest";
import { BlobStorePortLive } from "../../../adapters/blob-local/src/index.js";
import {
  P6_MIGRATIONS,
  runMigrations,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  type SendMessagePayload,
  sendMessagePlan,
} from "../../../packages/application/src/commands/send-message.js";
import { CommandGateway } from "../../../packages/application/src/index.js";
import {
  CommandId,
  MessageId,
  parse,
  WorkspaceId,
} from "../../../packages/domain/dist/index.js";
import {
  BlobStorePort,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
} from "../../../packages/ports/src/index.js";
import {
  makeP6App,
  p6Project,
  p6RootWorkspace,
  p6SeedProject,
  p6TestActor,
  p6TestPrincipal,
  runP6,
} from "../../support/p6-app.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";

const senderWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const senderSessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789d2";
const bodyPrefix = "CAPABILITY_B06_BLOB_MESSAGE_";
const createdBlobRefs: string[] = [];

afterEach(() => {
  for (const blobRef of createdBlobRefs.splice(0)) {
    rmSync(join(tmpdir(), "arbor-blobs", blobRef), { force: true });
  }
});

const seedChildWorkspace = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          senderWorkspaceId,
          p6Project,
          p6RootWorkspace,
          "capability-child",
          JSON.stringify({
            purpose: "Send one test report to the parent.",
            ownedResponsibilities: [],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          }),
          1,
          JSON.stringify({ basisResponsibilityRevision: 1, addresses: [] }),
          1,
          JSON.stringify({
            _tag: "ResponsibilityBound",
            workspaceId: senderWorkspaceId,
          }),
          senderSessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [senderSessionId, "WorkspacePrimary", senderWorkspaceId, 0, "t"],
      );
    }),
  );
});

describe("B06 L2 — BlobStore body to durable Message and Inbox", () => {
  defineCapabilityTest(
    metadataFor("B06", "L2"),
    "stores exact body bytes before committing the Message and Inbox reference",
    async () => {
      const databaseDirectory = join(
        tmpdir(),
        `arbor-b06-blob-${randomUUID()}`,
      );
      mkdirSync(databaseDirectory, { recursive: true });
      const databaseFile = join(databaseDirectory, "slice.db");
      const body = `${bodyPrefix}${randomUUID()}`;
      const bytes = new TextEncoder().encode(body);
      const expectedBlobRef = createHash("sha256").update(bytes).digest("hex");
      const messageId = parse(MessageId)(
        `msg_018f2b3c-4d5e-7abc-8def-0123456789e1`,
      );
      const commandId = parse(CommandId)(
        `cmd_018f2b3c-4d5e-7abc-8def-0123456789e1`,
      );
      const payload: SendMessagePayload = {
        messageId,
        senderWorkspaceId,
        message: {
          kind: "Report",
          recipientWorkspaceId: p6RootWorkspace,
          bodyRef: expectedBlobRef,
          urgency: "Normal",
        },
      };
      const app = Layer.mergeAll(makeP6App(databaseFile), BlobStorePortLive);
      try {
        const result = await runP6(
          Effect.gen(function* () {
            yield* runMigrations(P6_MIGRATIONS);
            yield* p6SeedProject;
            yield* seedChildWorkspace;
            const blobStore = yield* BlobStorePort;
            const actualBlobRef = yield* blobStore.put(bytes);
            createdBlobRefs.push(actualBlobRef);
            const readBack = yield* blobStore.get(actualBlobRef);
            const gateway = yield* CommandGateway;
            const plan = sendMessagePlan({
              messageId,
              commandId,
              projectId: p6Project,
              senderWorkspaceId,
              principal: p6TestPrincipal,
              actor: p6TestActor,
              message: payload.message,
            });
            const receipt = yield* gateway.execute(
              {
                commandType: "SendMessage",
                commandId,
                projectId: p6Project,
                actor: p6TestActor,
                issuedAt: "capability-test",
                payload,
              },
              { _tag: "External", principal: p6TestPrincipal },
              plan.authority,
            );
            const tx = yield* TransactionPort;
            const messages = yield* MessageStore;
            const stored = yield* tx.transact(messages.findById(messageId));
            const inbox = yield* InboxProjectionStore;
            const entries = yield* tx.transact(
              inbox.listUnconsumed(p6RootWorkspace),
            );
            return {
              receipt,
              actualBlobRef,
              readBack,
              stored,
              entries,
            };
          }),
          app,
        );
        expect(result.actualBlobRef).toBe(expectedBlobRef);
        expect(new TextDecoder().decode(result.readBack)).toBe(body);
        expect(result.receipt.resolution._tag).toBe("Committed");
        expect(Option.isSome(result.stored)).toBe(true);
        if (Option.isSome(result.stored)) {
          expect(result.stored.value.message.bodyRef).toBe(expectedBlobRef);
        }
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
          recipientWorkspaceId: p6RootWorkspace,
          entryKey: `msg:${messageId}`,
          kind: "Message",
        });
      } finally {
        rmSync(databaseDirectory, { recursive: true, force: true });
      }
    },
  );
});
