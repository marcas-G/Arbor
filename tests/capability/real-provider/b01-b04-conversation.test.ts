import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { secretRef } from "../../../packages/ports/dist/provider.js";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import {
  makePublicProject,
  responseBodyFrom,
  runPublicConversation,
} from "../support/public-chat.js";
import {
  type HttpProviderCallEvidence,
  type HttpProviderRuntime,
  makeHttpProviderClient,
  runtimeForProvider,
} from "./http-sdk-client.js";

const memoryCode = "BLUE-WHALE-17";
const memoryQuestion = "我刚才让你记住的代码是什么？";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RealProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision?: string;
  readonly apiKey?: string;
}

const realProviderConfig = (): RealProviderConfig => {
  const baseUrl = process.env.ARBOR_CAPABILITY_PROVIDER_URL?.trim();
  const model = process.env.ARBOR_CAPABILITY_MODEL?.trim();
  const serverBuildId = process.env.ARBOR_CAPABILITY_SERVER_BUILD_ID?.trim();
  const authMode = process.env.ARBOR_CAPABILITY_AUTH;
  const modelRevision = process.env.ARBOR_CAPABILITY_MODEL_REVISION?.trim();
  const apiKey = process.env.ARBOR_CAPABILITY_API_KEY;
  if (!baseUrl || !model || !serverBuildId) {
    throw new Error(
      "ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, and ARBOR_CAPABILITY_SERVER_BUILD_ID are required",
    );
  }
  if (authMode !== "none" && authMode !== "env") {
    throw new Error(
      "ARBOR_CAPABILITY_AUTH must be explicitly set to none or env",
    );
  }
  if (authMode === "env" && !apiKey) {
    throw new Error(
      "ARBOR_CAPABILITY_API_KEY is required when ARBOR_CAPABILITY_AUTH=env",
    );
  }
  return {
    baseUrl,
    model,
    serverBuildId,
    authMode,
    ...(modelRevision === undefined ? {} : { modelRevision }),
    ...(apiKey === undefined ? {} : { apiKey }),
  };
};

const evidenceDirectory = (): string =>
  resolve(
    process.env.ARBOR_CAPABILITY_EVIDENCE_DIR ??
      "planning/testing/core-capability/evidence/real-provider",
  );

const captureEvidence = (input: {
  readonly caseId: string;
  readonly runtime: HttpProviderRuntime;
  readonly calls: ReadonlyArray<HttpProviderCallEvidence>;
  readonly result: unknown;
  readonly status: "PASS" | "FAIL";
  readonly error?: string;
}): void => {
  const directory = evidenceDirectory();
  mkdirSync(directory, { recursive: true });
  const path = join(
    directory,
    `${input.caseId}-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  const generation = input.calls.map((call) => ({
    providerTurnId: call.providerTurnId,
    attemptNo: call.attemptNo,
    outputTokenLimit: call.request.max_tokens ?? null,
    temperature: call.request.temperature ?? input.runtime.temperature,
    temperatureWasSent: call.request.temperature !== undefined,
    reasoning: input.runtime.reasoningSettings,
    toolChoice:
      call.request.tool_choice ??
      "endpoint default (auto when tools are advertised)",
    toolDefinitions: call.request.tools ?? [],
    endpoint: call.endpoint,
  }));
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: "arbor-real-provider-evidence-v1",
        recordedAt: new Date().toISOString(),
        caseId: input.caseId,
        status: input.status,
        ...(input.error === undefined ? {} : { error: input.error }),
        provider: {
          provider: "OpenAI-compatible Qwen local server",
          endpoint: input.runtime.endpoint,
          model: input.runtime.model,
          serverBuildId: input.runtime.serverBuildId,
          modelRevision: input.runtime.modelRevision,
          authMode: input.runtime.authMode,
          serverProps: input.runtime.serverProps,
        },
        generation,
        requestsAndResponses: input.calls,
        externallyObservedResult: input.result,
      },
      null,
      2,
    )}\n`,
  );
};

const runAndCapture = async <A>(input: {
  readonly caseId: string;
  readonly body: (
    runtime: HttpProviderRuntime,
    calls: Array<HttpProviderCallEvidence>,
  ) => Promise<A>;
  readonly verify: (result: A) => void;
}): Promise<A> => {
  const config = realProviderConfig();
  const runtime = await runtimeForProvider({
    baseUrl: config.baseUrl,
    model: config.model,
    serverBuildId: config.serverBuildId,
    authMode: config.authMode,
    ...(config.modelRevision === undefined
      ? {}
      : { modelRevision: config.modelRevision }),
  });
  const calls: Array<HttpProviderCallEvidence> = [];
  let externalResult: unknown;
  try {
    const result = await input.body(runtime, calls);
    externalResult = result;
    input.verify(result);
    captureEvidence({
      caseId: input.caseId,
      runtime,
      calls,
      result,
      status: "PASS",
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    captureEvidence({
      caseId: input.caseId,
      runtime,
      calls,
      result: externalResult,
      status: "FAIL",
      error: detail,
    });
    throw error;
  }
};

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
          const projectA = makePublicProject("b04-session-a");
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

          const projectB = makePublicProject("b04-unrelated-root");
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
            turn2?.entries.find(
              (entry) => entry.kind === "HumanConversationTurn",
            ),
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
