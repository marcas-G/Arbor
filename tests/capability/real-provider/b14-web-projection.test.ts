import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  newCapabilityId,
  type PublicTranscriptPage,
  withPublicConversationApp,
} from "../support/public-chat.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const TURN_COUNT = 3;

describe("B14 L3 — web/product projection with real generated replies", () => {
  defineCapabilityTest(
    metadataFor("B14", "L3"),
    "B14: real-model turns project to the public transcript with correct pagination and no internal output",
    async () => {
      await runAndCapture({
        caseId: "B14-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B14_TURN_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          const project = makePublicProject(`b14-${marker}`);
          const directory = join(tmpdir(), `arbor-b14-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          let latest: PublicTranscriptPage | undefined;
          let older: PublicTranscriptPage | undefined;
          let oldest: PublicTranscriptPage | undefined;
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
                  `public CreateProject failed: ${created.status} ${JSON.stringify(created.payload)}`,
                );
              }
              for (let turn = 0; turn < TURN_COUNT; turn += 1) {
                const submitted = await handle.postCommand({
                  commandType: "SubmitHumanMessage",
                  commandId: newCapabilityId("cmd"),
                  projectId: project.projectId,
                  actor: "user:capability-test",
                  issuedAt: new Date().toISOString(),
                  payload: {
                    messageId: newCapabilityId("msg"),
                    targetWorkspaceId: project.rootWorkspaceId,
                    bodyRef:
                      turn === TURN_COUNT - 1
                        ? `请原样回复这个标记：${marker}`
                        : `这是第 ${turn + 1} 条消息，请简短确认。`,
                  },
                });
                if (
                  submitted.status !== 200 ||
                  (
                    submitted.payload.body as
                      | { resolution?: string }
                      | undefined
                  )?.resolution !== "Committed"
                ) {
                  throw new Error(
                    `public SubmitHumanMessage failed: ${submitted.status} ${JSON.stringify(submitted.payload)}`,
                  );
                }
                await handle.tick();
                await handle.tick();
              }

              // Latest page (2 entries), then walk the stable cursor back
              // through the older range without replacing it.
              latest = await handle.readTranscript({
                workspaceId: project.rootWorkspaceId,
                limit: 2,
                conversationOnly: true,
              });
              if (latest.nextCursor === undefined) {
                throw new Error("expected a cursor for the older page");
              }
              older = await handle.readTranscript({
                workspaceId: project.rootWorkspaceId,
                limit: 2,
                conversationOnly: true,
                cursor: latest.nextCursor,
              });
              if (older.nextCursor !== undefined) {
                oldest = await handle.readTranscript({
                  workspaceId: project.rootWorkspaceId,
                  limit: 2,
                  conversationOnly: true,
                  cursor: older.nextCursor,
                });
              }
            },
          );
          return { marker, latest, older, oldest, providerCalls: calls };
        },
        verify: (result) => {
          const pages = [result.latest, result.older, result.oldest].filter(
            (page): page is PublicTranscriptPage => page !== undefined,
          );
          const entries = pages.flatMap((page) => page.entries);
          const kinds = entries.map((entry) => entry.kind);
          // No internal ModelOutput ever reaches the product transcript.
          const internal = kinds.filter(
            (kind) =>
              kind !== "HumanConversationTurn" &&
              kind !== "AssistantConversationTurn",
          );
          if (internal.length > 0) {
            throw new Error(
              `internal entries leaked to the product transcript: ${JSON.stringify(internal)}`,
            );
          }
          const humans = entries.filter(
            (entry) => entry.kind === "HumanConversationTurn",
          );
          const assistants = entries.filter(
            (entry) => entry.kind === "AssistantConversationTurn",
          );
          if (
            humans.length !== TURN_COUNT ||
            assistants.length !== TURN_COUNT
          ) {
            throw new Error(
              `expected ${TURN_COUNT} Human/Assistant pairs across pages, found human=${humans.length} assistant=${assistants.length}`,
            );
          }
          // Chronological order holds within and across pages (older pages
          // prepend, they never replace the current interval).
          const bodies = entries.map((entry) => entry.body);
          const firstMessages = bodies.filter((body) =>
            body.includes("第 1 条消息"),
          );
          const markerReplies = bodies.filter((body) =>
            body.includes(result.marker),
          );
          if (firstMessages.length !== 1) {
            throw new Error(
              "the oldest page did not carry exactly the first human turn",
            );
          }
          if (markerReplies.length !== 1) {
            throw new Error(
              "the latest page did not carry exactly the marker reply",
            );
          }
          const indexOfFirst = bodies.indexOf(firstMessages[0] ?? "");
          const indexOfMarkerReply = bodies.indexOf(markerReplies[0] ?? "");
          if (indexOfFirst >= indexOfMarkerReply) {
            throw new Error(
              "pagination broke chronological order (older range after newer range)",
            );
          }
        },
      });
    },
  );
});
