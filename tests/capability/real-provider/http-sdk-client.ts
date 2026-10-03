import type { OpenAISdkClient } from "../../../adapters/provider-openai/src/index.js";
import {
  type OpenAICompatibleFetch,
  OpenAICompatibleFetchClient,
  type OpenAICompatibleFetchResponse,
} from "../../../adapters/provider-openai/src/index.js";

export interface HttpProviderCallEvidence {
  readonly providerTurnId: string;
  readonly attemptNo: number;
  readonly endpoint: string;
  readonly request: Record<string, unknown>;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBodyBase64?: string;
  error?: string;
}

export interface HttpProviderRuntime {
  readonly endpoint: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision: string;
  readonly serverProps: unknown;
  readonly temperature: number;
  readonly reasoningSettings: string;
  readonly contextWindow: number;
  readonly outputCeiling: number;
}

const isLoopbackEndpoint = (endpoint: string): boolean => {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
};

const bytesToBase64 = (chunks: ReadonlyArray<Uint8Array>): string => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return Buffer.from(bytes).toString("base64");
};

/** Observes the production transport without owning request rendering, SSE
 * parsing, cancellation, deadline or error taxonomy. */
const captureFetch =
  (input: {
    readonly captures: Array<HttpProviderCallEvidence>;
    readonly providerTurnId: string;
    readonly attemptNo: number;
  }): OpenAICompatibleFetch =>
  async (url, init) => {
    const capture: HttpProviderCallEvidence = {
      providerTurnId: input.providerTurnId,
      attemptNo: input.attemptNo,
      endpoint: url,
      request: JSON.parse(init.body) as Record<string, unknown>,
    };
    input.captures.push(capture);
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal as AbortSignal,
      });
      capture.responseStatus = response.status;
      capture.responseHeaders = Object.fromEntries(
        [...response.headers.entries()].filter(([name]) =>
          ["content-type", "x-request-id", "server"].includes(
            name.toLowerCase(),
          ),
        ),
      );
      if (!response.ok || response.body === null) {
        const body = response.body === null ? "" : await response.text();
        capture.responseBodyBase64 = Buffer.from(body).toString("base64");
        return { ok: response.ok, status: response.status, body: null };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            capture.responseBodyBase64 = bytesToBase64(chunks);
            controller.close();
            return;
          }
          chunks.push(next.value);
          controller.enqueue(next.value);
        },
        async cancel() {
          await reader.cancel();
          capture.responseBodyBase64 = bytesToBase64(chunks);
        },
      });
      return {
        ok: response.ok,
        status: response.status,
        body,
      } satisfies OpenAICompatibleFetchResponse;
    } catch (error) {
      capture.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

export const runtimeForProvider = async (input: {
  readonly baseUrl: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision?: string;
  readonly apiKey?: string;
}): Promise<HttpProviderRuntime> => {
  let contextWindow = 8_192;
  let outputCeiling = 2_048;
  try {
    const response = await fetch(
      `${input.baseUrl.replace(/\/+$/u, "")}/models`,
      {
        headers:
          input.apiKey === undefined
            ? {}
            : { authorization: `Bearer ${input.apiKey}` },
      },
    );
    if (response.ok) {
      const body = (await response.json()) as {
        readonly data?: ReadonlyArray<{
          readonly id?: unknown;
          readonly context_window?: unknown;
          readonly max_output_tokens?: unknown;
        }>;
      };
      const model = body.data?.find(
        (candidate) => candidate.id === input.model,
      );
      if (
        typeof model?.context_window === "number" &&
        Number.isSafeInteger(model.context_window) &&
        model.context_window > 0
      ) {
        contextWindow = model.context_window;
      }
      if (
        typeof model?.max_output_tokens === "number" &&
        Number.isSafeInteger(model.max_output_tokens) &&
        model.max_output_tokens > 0
      ) {
        // Qualification keeps its output request bounded while preserving the
        // provider's true context capacity.
        outputCeiling = Math.min(model.max_output_tokens, 8_192);
      }
    }
  } catch {
    // Capability discovery is advisory; explicit conservative fallbacks keep
    // local/offline qualification usable.
  }
  return {
    endpoint: input.baseUrl,
    model: input.model,
    serverBuildId: input.serverBuildId,
    authMode: input.authMode,
    modelRevision:
      input.modelRevision ??
      "not exposed by provider; local model file revision/hash not requested",
    serverProps: {},
    temperature: 0,
    reasoningSettings:
      "Production client defaults; qualification does not override generation parameters",
    contextWindow,
    outputCeiling,
  };
};

export const makeHttpProviderClient = (input: {
  readonly runtime: HttpProviderRuntime;
  readonly apiKey?: string;
  readonly captures: Array<HttpProviderCallEvidence>;
}): OpenAISdkClient => ({
  externalEffectPossible: !isLoopbackEndpoint(input.runtime.endpoint),
  streamChat: async function* (request) {
    const client = OpenAICompatibleFetchClient({
      baseUrl: input.runtime.endpoint,
      model: input.runtime.model,
      ...(input.runtime.authMode === "none"
        ? { allowUnauthenticated: true }
        : {}),
      fetch: captureFetch({
        captures: input.captures,
        providerTurnId: request.context.providerTurnId,
        attemptNo: request.context.attemptNo,
      }),
    });
    yield* client.streamChat(request);
  },
});
