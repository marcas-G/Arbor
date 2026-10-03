import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type {
  HttpProviderCallEvidence,
  HttpProviderRuntime,
} from "../real-provider/http-sdk-client.js";
import {
  providerConfigReady,
  resolveProviderConfig,
} from "./provider-config.js";

export interface RealProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision?: string;
  readonly apiKey?: string;
}

export const realProviderConfig = (): RealProviderConfig => {
  const resolved = resolveProviderConfig();
  const readiness = providerConfigReady(resolved);
  if (!readiness.ready) {
    throw new Error(
      `real provider configuration is incomplete (capability.config.json / ARBOR_CAPABILITY_* env): missing ${readiness.missing.join(
        ", ",
      )}`,
    );
  }
  return {
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    serverBuildId: resolved.serverBuildId,
    authMode: resolved.authMode,
    ...(resolved.modelRevision === undefined
      ? {}
      : { modelRevision: resolved.modelRevision }),
    ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
  };
};

export const evidenceDirectory = (): string => {
  const resolved = resolveProviderConfig();
  return resolve(
    resolved.evidenceDir ??
      "planning/testing/core-capability/evidence/real-provider",
  );
};

export const safeEvidenceError = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  const seen = new WeakSet<object>();
  try {
    const encoded = JSON.stringify(error, (key, value: unknown) => {
      if (/authorization|api[-_]?key|secret|credential/iu.test(key)) {
        return "[REDACTED]";
      }
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
    return (encoded ?? String(error)).slice(0, 8_000);
  } catch {
    return String(error).slice(0, 8_000);
  }
};

export const captureEvidence = (input: {
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
          provider: "OpenAI-compatible endpoint",
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

export const runAndCapture = async <A>(input: {
  readonly caseId: string;
  readonly body: (
    runtime: HttpProviderRuntime,
    calls: Array<HttpProviderCallEvidence>,
  ) => Promise<A>;
  readonly verify: (result: A) => void;
}): Promise<A> => {
  const config = realProviderConfig();
  const { runtimeForProvider } = await import(
    "../real-provider/http-sdk-client.js"
  );
  const runtime = await runtimeForProvider({
    baseUrl: config.baseUrl,
    model: config.model,
    serverBuildId: config.serverBuildId,
    authMode: config.authMode,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
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
    const detail = safeEvidenceError(error);
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

export const expectOneAssistantTurn = (
  entries: ReadonlyArray<{ kind: string }>,
) => {
  expect(
    entries.filter((entry) => entry.kind === "AssistantConversationTurn"),
  ).toHaveLength(1);
};
