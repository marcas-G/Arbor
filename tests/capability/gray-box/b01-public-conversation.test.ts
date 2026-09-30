import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../../../apps/single-workspace/src/composition.js";
import {
  ProductionDaemonService,
  TransportBoundary,
} from "../../../apps/single-workspace/src/production.js";
import { makeStaticAuthenticator } from "../../../apps/single-workspace/src/transport/auth.js";
import { startWebTransport } from "../../../apps/single-workspace/src/transport/server.js";
import {
  Principal,
  ProjectId,
  parse,
} from "../../../packages/domain/src/index.js";
import type { ModelCatalog } from "../../../packages/model-context/src/index.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import {
  makePublicProject,
  makeRecordingProvider,
  newCapabilityId,
} from "../support/public-chat.js";

const TOKEN = "tok_capability_b01";
const HUMAN = parse(Principal)("user:capability-test");
const modelRef = "capability-recording-model";
const assistantResponse = "CAPABILITY_B01_FORMAL_ASSISTANT_RESPONSE";

const modelCatalog: ModelCatalog = {
  defaultModelRef: modelRef,
  entries: [
    {
      modelRef,
      adapterId: "provider-openai",
      capability: {
        modelRef,
        family: "openai-compatible",
        contextWindow: 8_192,
        outputCeiling: 512,
        toolProtocol: "json",
        capabilities: ["text", "tools"],
      },
    },
  ],
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("B01 L2 — public Human Input to durable transcript", () => {
  defineCapabilityTest(
    metadataFor("B01", "L2"),
    "submits through HTTP, runs the production daemon, and reads one Assistant turn",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "arbor-b01-public-"));
      directories.push(directory);
      const databaseFile = join(directory, "slice.db");
      const project = makePublicProject(
        `capability-b01-${crypto.randomUUID()}`,
      );
      const projectId = parse(ProjectId)(project.projectId);
      const requests: Array<Record<string, unknown>> = [];
      const client = makeRecordingProvider(assistantResponse, requests);
      const app = buildSingleWorkspaceLayer({
        databaseFile,
        projectId,
        modelCatalog,
        modelRef,
        provider: { adapterId: "provider-openai", client },
        authenticator: makeStaticAuthenticator({ [TOKEN]: HUMAN }),
        governance: { authenticatedHumans: [HUMAN], directParentOf: [] },
      });

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* runMigrations(CURRENT_MIGRATIONS);
              const boundary = yield* TransportBoundary;
              const sql = yield* SqlClient;
              const daemon = yield* ProductionDaemonService;
              yield* daemon.daemon.start;
              const handle = yield* Effect.promise(() =>
                startWebTransport({
                  http: boundary.http,
                  webSocket: boundary.webSocket,
                  sql,
                  projectDirectory: { list: () => Effect.succeed([]) },
                  pollIntervalMs: 60_000,
                }),
              );
              const base = `http://127.0.0.1:${handle.port}`;
              const headers = {
                "content-type": "application/json",
                authorization: `Bearer ${TOKEN}`,
              };
              const postCommand = (envelope: Record<string, unknown>) =>
                Effect.promise(async () => {
                  const response = await fetch(`${base}/commands`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(envelope),
                  });
                  return {
                    status: response.status,
                    payload: (await response.json()) as {
                      ok: boolean;
                      body?: { resolution?: string };
                    },
                  };
                });
              try {
                const created = yield* postCommand({
                  commandType: "CreateProject",
                  commandId: newCapabilityId("cmd"),
                  projectId: project.projectId,
                  actor: "user:capability-test",
                  issuedAt: new Date().toISOString(),
                  payload: project,
                });
                expect(created.status).toBe(200);
                expect(created.payload.body?.resolution).toBe("Committed");

                const messageId = newCapabilityId("msg");
                const commandId = newCapabilityId("cmd");
                const humanInput = "请给出一条简短建议。";
                const submission = {
                  commandType: "SubmitHumanMessage",
                  commandId,
                  projectId: project.projectId,
                  actor: "user:capability-test",
                  issuedAt: new Date().toISOString(),
                  payload: {
                    messageId,
                    targetWorkspaceId: project.rootWorkspaceId,
                    bodyRef: humanInput,
                  },
                };
                const submitted = yield* postCommand(submission);
                const duplicate = yield* postCommand(submission);
                expect(submitted.status).toBe(200);
                expect(submitted.payload.body?.resolution).toBe("Committed");
                expect(duplicate.status).toBe(200);
                expect(duplicate.payload.body?.resolution).toBe("Committed");

                yield* daemon.daemon.conversationTick;
                yield* daemon.daemon.conversationTick;

                const transcriptResponse = yield* Effect.promise(() =>
                  fetch(`${base}/views/transcript`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      workspaceId: project.rootWorkspaceId,
                      limit: 10,
                    }),
                  }),
                );
                expect(transcriptResponse.status).toBe(200);
                const transcript = (yield* Effect.promise(() =>
                  transcriptResponse.json(),
                )) as {
                  ok: boolean;
                  body: {
                    value: {
                      entries: ReadonlyArray<{
                        readonly kind: string;
                        readonly body: string;
                        readonly messageId?: string;
                      }>;
                    };
                  };
                };
                return { messageId, humanInput, transcript };
              } finally {
                yield* Effect.promise(() => handle.close());
              }
            }),
            app,
          ),
        ),
      );

      expect(result.transcript.ok).toBe(true);
      const humanTurns = result.transcript.body.value.entries.filter(
        (entry) => entry.kind === "HumanConversationTurn",
      );
      const assistantTurns = result.transcript.body.value.entries.filter(
        (entry) => entry.kind === "AssistantConversationTurn",
      );
      expect(humanTurns).toHaveLength(1);
      expect(assistantTurns).toHaveLength(1);
      expect(humanTurns[0]).toMatchObject({
        messageId: result.messageId,
        body: result.humanInput,
      });
      expect(assistantTurns[0]?.body).toBe(assistantResponse);
      expect(requests).toHaveLength(1);
    },
  );
});
