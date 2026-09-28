import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";
import type {
  OpenAISdkChunk,
  OpenAISdkClient,
} from "../../../adapters/provider-openai/src/index.js";
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

/** Deterministic infrastructure fault injection (B13 allowed setup): the
 * first N provider calls fail with a synthetic retryable server error
 * (OpenAI-compatible 503 server_error shape), afterwards traffic flows to
 * the real provider. */
const makeFlakyRealProvider = (
  inner: OpenAISdkClient,
  failuresRemaining: { count: number },
): OpenAISdkClient => ({
  streamChat: async function* (input): AsyncIterable<OpenAISdkChunk> {
    if (failuresRemaining.count > 0) {
      failuresRemaining.count -= 1;
      const error = Object.assign(
        new Error("simulated transient provider outage (HTTP 503)"),
        { name: "OpenAISdkError", status: 503, code: "server_error" },
      );
      throw error;
    }
    yield* inner.streamChat(input);
  },
});

describe("B13 L3 — transient provider failure recovers without duplicated effects", () => {
  defineCapabilityTest(
    metadataFor("B13", "L3"),
    "B13: one injected transient provider failure stays visible and bounded and the turn still completes exactly once",
    async () => {
      await runAndCapture({
        caseId: "B13-L3-REAL",
        body: async (runtime, calls) => {
          const marker = `B13_ACK_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
          const project = makePublicProject(`b13-${marker}`);
          const directory = join(tmpdir(), `arbor-b13-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const real = makeHttpProviderClient({
            runtime,
            ...(process.env.ARBOR_CAPABILITY_API_KEY === undefined
              ? {}
              : { apiKey: process.env.ARBOR_CAPABILITY_API_KEY }),
            captures: calls,
          });
          const provider = makeFlakyRealProvider(real, { count: 1 });
          let transcript: PublicTranscriptPage | undefined;
          await withPublicConversationApp(
            {
              databaseFile: join(directory, "slice.db"),
              project,
              modelRef: runtime.model,
              provider,
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
              const submitted = await handle.postCommand({
                commandType: "SubmitHumanMessage",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: {
                  messageId: newCapabilityId("msg"),
                  targetWorkspaceId: project.rootWorkspaceId,
                  bodyRef: `请把下面的标记原样作为普通文本回复：${marker}`,
                },
              });
              if (
                submitted.status !== 200 ||
                (submitted.payload.body as { resolution?: string } | undefined)
                  ?.resolution !== "Committed"
              ) {
                throw new Error(
                  `public SubmitHumanMessage failed: ${submitted.status} ${JSON.stringify(submitted.payload)}`,
                );
              }
              // Bounded drive: the retry-until-response sweep must converge
              // within a small number of ticks.
              for (let tick = 0; tick < 12; tick += 1) {
                await handle.tick();
                transcript = await handle.readTranscript({
                  workspaceId: project.rootWorkspaceId,
                  limit: 20,
                });
                if (
                  transcript.entries.some(
                    (entry) => entry.kind === "AssistantConversationTurn",
                  )
                ) {
                  break;
                }
              }
            },
          );
          return {
            marker,
            transcript,
            providerCalls: calls,
          };
        },
        verify: (result) => {
          // The failure stayed visible: exactly one captured call ends in
          // the injected transient error.
          const failedCalls = result.providerCalls.filter(
            (call) => call.error !== undefined,
          );
          if (failedCalls.length !== 1) {
            throw new Error(
              `expected exactly one visible failed provider attempt, found ${failedCalls.length}`,
            );
          }
          if (
            !failedCalls[0]?.error?.includes(
              "simulated transient provider outage",
            )
          ) {
            throw new Error(
              `unexpected failure kind: ${failedCalls[0]?.error ?? "none"}`,
            );
          }
          const entries = result.transcript?.entries ?? [];
          const human = entries.filter(
            (entry) => entry.kind === "HumanConversationTurn",
          );
          const assistant = entries.filter(
            (entry) => entry.kind === "AssistantConversationTurn",
          );
          if (human.length !== 1 || assistant.length !== 1) {
            throw new Error(
              `recovery duplicated or lost turns — human=${human.length} assistant=${assistant.length}: ${JSON.stringify(entries.map((entry) => entry.kind))}`,
            );
          }
          if (!assistant[0]?.body.includes(result.marker)) {
            throw new Error(
              `the recovered assistant turn does not answer the submitted message: ${assistant[0]?.body ?? "none"}`,
            );
          }
        },
      });
    },
  );
});
