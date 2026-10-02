import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import {
  makePublicProject,
  responseBodyFrom,
  runPublicConversation,
} from "../support/public-chat.js";
import { makeHttpProviderClient } from "./http-sdk-client.js";

const memoryCode = "BLUE-WHALE-17";
const memoryQuestion = "我刚才让你记住的代码是什么？";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const createTurn = (text: string, duplicateSubmission = false) => ({
  body: text,
  duplicateSubmission,
});

describe("real-provider capability sentinels", () => {
  defineCapabilityTest(
    metadataFor("B01", "L3"),
    "B01: external Human submission yields one durable Assistant transcript turn",
    async () => {
      await runAndCapture({
        caseId: "B01-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B01_ACK_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
          const project = makePublicProject(`b01-${marker}`);
          const projectDir = join(tmpdir(), `arbor-b01-real-${randomUUID()}`);
          mkdirSync(projectDir, { recursive: true });
          temporaryDirectories.push(projectDir);
          const result = await runPublicConversation({
            databaseFile: join(projectDir, "slice.db"),
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
            turns: [
              createTurn(`请把下面的标记原样作为普通文本回复：${marker}`, true),
            ],
          });
          const transcript = result.transcripts[0];
          if (transcript === undefined) {
            throw new Error("real B01 run did not return a transcript page");
          }
          const entries = transcript.entries;
          const assistantBodies = responseBodyFrom(transcript);
          return {
            marker,
            entries,
            assistantBodies,
            providerCalls: calls.length,
            projectId: project.projectId,
            transcript: result.transcripts[0],
          };
        },
        verify: (result) => {
          expect(
            result.entries.filter(
              (entry) => entry.kind === "HumanConversationTurn",
            ),
          ).toHaveLength(1);
          expect(
            result.entries.filter(
              (entry) => entry.kind === "AssistantConversationTurn",
            ),
          ).toHaveLength(1);
          expect(result.providerCalls).toBeGreaterThan(0);
          expect(result.assistantBodies).toHaveLength(1);
          expect(result.assistantBodies[0]).toContain(result.marker);
          expect(result.assistantBodies[0]?.length).toBeLessThanOrEqual(4_000);
        },
      });
    },
  );

  defineCapabilityTest(
    metadataFor("B04", "L3"),
    "B04: real-model recall uses same-root history and isolates another root",
    async () => {
      await runAndCapture({
        caseId: "B04-L3-REAL",
        body: async (runtime, calls) => {
          const databaseDirectory = join(
            tmpdir(),
            `arbor-b04-real-${randomUUID()}`,
          );
          mkdirSync(databaseDirectory, { recursive: true });
          temporaryDirectories.push(databaseDirectory);
          const databaseFile = join(databaseDirectory, "slice.db");
          const provider = makeHttpProviderClient({
            runtime,
            ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
              ? {}
              : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
            captures: calls,
          });
          const projectA = makePublicProject(
            "b04-session-a",
            databaseDirectory,
          );
          const sameRoot = await runPublicConversation({
            databaseFile,
            project: projectA,
            modelRef: runtime.model,
            provider,
            ...(runtime.authMode === "env"
              ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
              : {}),
            turns: [
              createTurn(`记住代码 ${memoryCode}。只需简短确认。`),
              createTurn(memoryQuestion),
            ],
          });
          const turn2 = sameRoot.transcripts[1];
          const sameRootReply = responseBodyFrom(turn2 ?? { entries: [] })[0];

          const projectBRoot = join(
            tmpdir(),
            `arbor-b04-unrelated-${randomUUID()}`,
          );
          mkdirSync(projectBRoot, { recursive: true });
          temporaryDirectories.push(projectBRoot);
          const projectB = makePublicProject(
            "b04-unrelated-root",
            projectBRoot,
          );
          const callsBeforeUnrelatedRoot = calls.length;
          const unrelated = await runPublicConversation({
            databaseFile,
            project: projectB,
            modelRef: runtime.model,
            provider,
            ...(runtime.authMode === "env"
              ? { secretRef: secretRef("ARBOR_CAPABILITY_API_KEY") }
              : {}),
            turns: [createTurn(memoryQuestion)],
          });
          const unrelatedReply = responseBodyFrom(
            unrelated.transcripts[0] ?? { entries: [] },
          )[0];
          const currentTurnText = JSON.stringify(
            [...(turn2?.entries ?? [])]
              .reverse()
              .find((entry) => entry.kind === "HumanConversationTurn"),
          );
          const unrelatedRootRequests = calls
            .slice(callsBeforeUnrelatedRoot)
            .map((call) => call.request);

          return {
            sessionA: {
              turn1: sameRoot.transcripts[0],
              turn2,
              turn2InputContainsMemoryCode:
                currentTurnText.includes(memoryCode),
              reply: sameRootReply,
            },
            unrelatedRoot: {
              transcript: unrelated.transcripts[0],
              reply: unrelatedReply,
              requests: unrelatedRootRequests,
            },
            diagnostic: {
              providerCalls: calls.length,
              note: "Captured Provider requests/responses are diagnostic evidence; the PASS oracle is the externally read transcript.",
            },
          };
        },
        verify: (result) => {
          expect(result.sessionA.reply).toBeDefined();
          expect(result.sessionA.reply).toContain(memoryCode);
          expect(result.sessionA.turn2InputContainsMemoryCode).toBe(false);
          expect(result.unrelatedRoot.reply).toBeDefined();
          expect(result.unrelatedRoot.reply).not.toContain(memoryCode);
          expect(JSON.stringify(result.unrelatedRoot.requests)).not.toContain(
            memoryCode,
          );
        },
      });
    },
  );
});
