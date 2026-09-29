import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  newCapabilityId,
  withPublicConversationApp,
} from "../support/public-chat.js";
import { driveWorkExecution, submitWork } from "../support/work-execution.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("B06 L3 — parent/child communication through the adopted route", () => {
  defineCapabilityTest(
    metadataFor("B06", "L3"),
    "B06: a real model in a child workspace sends a durable Report to the parent",
    async () => {
      await runAndCapture({
        caseId: "B06-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B06_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(`b06-${marker}`);
          const childWorkspaceId = newCapabilityId("ws");
          const childSessionId = newCapabilityId("ses");
          const directory = join(tmpdir(), `arbor-b06-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const objective =
            "你的第一个动作必须是调用 arbor_send_message，参数 JSON：" +
            `{"kind": "Report", "body": "${marker} 阶段性汇报完成"}。` +
            "禁止调用 list、read、shell、patch。第二个动作调用 arbor_wait（reason done，waitSpec Any + Manual）。";
          let settlement: unknown;
          let messages: ReadonlyArray<messageRow> = [];
          let parentInbox: ReadonlyArray<inboxRow> = [];
          await withPublicConversationApp(
            {
              databaseFile: join(directory, "slice.db"),
              project,
              modelRef: runtime.model,
              provider: makeHttpProviderClient({
                runtime,
                ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
                  ? {}
                  : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
                captures: calls,
              }),
              ...(runtime.authMode === "env"
                ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
                : {}),
            },
            async (handle) => {
              const created = await handle.postCommand({
                commandType: "CreateProject",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: project,
              });
              if (
                created.status !== 200 ||
                (created.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `public CreateProject failed: ${created.status}`,
                );
              }
              const child = await handle.postCommand({
                commandType: "CreateChildWorkspace",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: {
                  parentWorkspaceId: project.rootWorkspaceId,
                  workspaceId: childWorkspaceId,
                  primarySession: {
                    sessionId: childSessionId,
                    contextEpoch: 0,
                  },
                  name: `child-${marker}`,
                  responsibilityDefinition: {
                    purpose: `child duty ${marker}`,
                    ownedResponsibilities: [],
                    obligations: [],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  },
                  responsibilityRevision: 0,
                  resourceBoundary: {
                    basisResponsibilityRevision: 0,
                    addresses: [
                      { _tag: "FileTree", path: process.cwd() },
                      { _tag: "GitWorktree", path: process.cwd() },
                    ],
                  },
                  resourceBoundaryRevision: 0,
                  agentBinding: {
                    _tag: "ResponsibilityBoundAgentBinding",
                    workspaceId: childWorkspaceId,
                  },
                  workspacePolicy: {},
                  workspacePolicyRevision: 0,
                  revision: 0,
                },
              });
              if (
                child.status !== 200 ||
                (child.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `public CreateChildWorkspace failed: ${child.status} ${JSON.stringify(child.payload).slice(0, 300)}`,
                );
              }
              const fixture = await submitWork(handle, project, objective, {
                workspaceId: childWorkspaceId,
                createProject: false,
              });
              const driven = await driveWorkExecution(
                handle,
                project,
                fixture,
                { workspaceId: childWorkspaceId },
              );
              settlement = driven.settlement;
              const rows = await handle.run(
                Effect.gen(function* () {
                  const sql = yield* SqlClient;
                  const messageRows = yield* sql.unsafe<messageRow>(
                    "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref FROM messages",
                  );
                  const inboxRows = yield* sql.unsafe<inboxRow>(
                    "SELECT workspace_id, kind, summary FROM inbox_entries WHERE workspace_id = ?",
                    [project.rootWorkspaceId],
                  );
                  return { messageRows, inboxRows };
                }),
              );
              messages = rows.messageRows;
              parentInbox = rows.inboxRows;
            },
          );
          return {
            marker,
            settlement,
            messages,
            parentInbox,
            rootWorkspaceId: project.rootWorkspaceId,
            childWorkspaceId,
            providerCalls: calls,
          };
        },
        verify: (result) => {
          const report = result.messages.find(
            (message) => message.kind === "Report",
          );
          if (report === undefined) {
            throw new Error(
              "no durable Report message was persisted for the child run",
            );
          }
          if (report.sender_workspace_id !== result.childWorkspaceId) {
            throw new Error(
              "the Report sender is not the child workspace that ran the model",
            );
          }
          if (report.recipient_workspace_id !== result.rootWorkspaceId) {
            throw new Error("the Report recipient is not the parent workspace");
          }
          const inboxEntry = result.parentInbox[0];
          if (inboxEntry === undefined) {
            throw new Error("the parent inbox never admitted the child Report");
          }
          if (inboxEntry.kind !== "Message") {
            throw new Error(
              `inbox admitted an unexpected kind: ${inboxEntry.kind}`,
            );
          }
        },
      });
    },
  );
});

interface messageRow {
  message_id: string;
  sender_workspace_id: string;
  recipient_workspace_id: string;
  kind: string;
  body_ref: string;
}

interface inboxRow {
  workspace_id: string;
  kind: string;
  summary: string;
}
