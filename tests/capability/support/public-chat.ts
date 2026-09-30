import { randomUUID } from "node:crypto";
import { type Context, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type {
  OpenAISdkChunk,
  OpenAISdkClient,
} from "../../../adapters/provider-openai/src/index.js";
import {
  buildSliceLayer,
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
import type { SecretRef } from "../../../packages/ports/dist/provider.js";

export const capabilityHuman = parse(Principal)("user:capability-test");
export const capabilityToken = "tok_arbor_capability_harness";

const uuidV7 = (): string => {
  const value = randomUUID().replaceAll("-", "").split("");
  value[12] = "7";
  return [
    value.slice(0, 8).join(""),
    value.slice(8, 12).join(""),
    value.slice(12, 16).join(""),
    value.slice(16, 20).join(""),
    value.slice(20).join(""),
  ].join("-");
};

const prefixedId = (prefix: string): string => `${prefix}_${uuidV7()}`;
export const newCapabilityId = prefixedId;

export interface PublicProject {
  readonly projectId: string;
  readonly rootWorkspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly projectPolicy: Record<string, never>;
  readonly projectPolicyRevision: number;
  readonly defaultConfiguration: Record<string, never>;
  readonly environmentRef: string;
  readonly primarySession: {
    readonly sessionId: string;
    readonly contextEpoch: number;
  };
  readonly rootWorkspace: {
    readonly name: string;
    readonly responsibilityDefinition: {
      readonly purpose: string;
      readonly ownedResponsibilities: ReadonlyArray<string>;
      readonly obligations: ReadonlyArray<string>;
      readonly includes: ReadonlyArray<string>;
      readonly excludes: ReadonlyArray<string>;
      readonly interfaces: ReadonlyArray<string>;
    };
    readonly responsibilityRevision: number;
    readonly resourceBoundary: {
      readonly basisResponsibilityRevision: number;
      readonly addresses: ReadonlyArray<unknown>;
    };
    readonly resourceBoundaryRevision: number;
    readonly agentBinding: {
      readonly _tag: "ResponsibilityBoundAgentBinding";
      readonly workspaceId: string;
    };
    readonly workspacePolicy: Record<string, never>;
    readonly workspacePolicyRevision: number;
    readonly revision: number;
  };
}

export interface CapturedProviderCall {
  readonly request: Record<string, unknown>;
  readonly response?: string;
  readonly error?: string;
}

export interface PublicConversationTurn {
  readonly body: string;
  readonly duplicateSubmission?: boolean;
}

export interface PublicConversationResult {
  readonly projectId: string;
  readonly transcripts: ReadonlyArray<{
    readonly entries: ReadonlyArray<{
      readonly kind: string;
      readonly body: string;
      readonly messageId?: string;
      readonly executionId?: string;
    }>;
  }>;
}

export const makeModelCatalog = (modelRef: string): ModelCatalog => ({
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
});

export const makeRecordingProvider = (
  responseText: string,
  requests: Array<Readonly<Record<string, unknown>>>,
): OpenAISdkClient => ({
  externalEffectPossible: false,
  streamChat: async function* ({ request }): AsyncIterable<OpenAISdkChunk> {
    requests.push({
      model: request.modelRef,
      messages: [
        ...request.instructions.map((instruction) => ({
          role: "system",
          content: instruction.text,
        })),
        ...request.messages.map((message) => ({
          role: message.role,
          content: message.text,
        })),
      ],
      tools: request.toolDefinitions,
      max_tokens: request.budget.maxOutputTokens,
      outputContractRef: request.outputContractRef,
    });
    yield { type: "text", text: responseText };
    yield { type: "completed", finishReason: "stop" };
  },
});

const commandEnvelope = (
  projectId: string,
  commandType: string,
  payload: unknown,
) => ({
  commandType,
  commandId: prefixedId("cmd"),
  projectId,
  actor: "user:capability-test",
  issuedAt: new Date().toISOString(),
  payload,
});

export const makePublicProject = (key: string): PublicProject => {
  const projectId = prefixedId("prj");
  const rootWorkspaceId = prefixedId("ws");
  const sessionId = prefixedId("ses");
  return {
    projectId,
    rootWorkspaceId,
    name: `Capability ${key}`,
    revision: 0,
    projectPolicy: {},
    projectPolicyRevision: 0,
    defaultConfiguration: {},
    environmentRef: "local",
    primarySession: { sessionId, contextEpoch: 0 },
    rootWorkspace: {
      name: "root",
      responsibilityDefinition: {
        purpose: `Capability test ${key}`,
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceBoundary: {
        basisResponsibilityRevision: 0,
        // Real boundary fact: the workspace owns the repository working tree.
        // Without an address, ResourceAdmission denies every tool region
        // ("region outside ResourceBoundary") and tool-use capabilities
        // cannot be exercised.
        addresses: [
          { _tag: "FileTree", path: process.cwd() },
          { _tag: "GitWorktree", path: process.cwd() },
        ],
      },
      resourceBoundaryRevision: 0,
      agentBinding: {
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: rootWorkspaceId,
      },
      workspacePolicy: {},
      workspacePolicyRevision: 0,
      revision: 0,
    },
  };
};

export interface PublicTranscriptEntry {
  readonly kind: string;
  readonly body: string;
  readonly messageId?: string;
  readonly executionId?: string;
}

export interface PublicTranscriptPage {
  readonly entries: ReadonlyArray<PublicTranscriptEntry>;
  readonly nextCursor?: string;
}

/** Handle over the assembled production slice: the public HTTP face plus an
 * in-process escape hatch that runs Effects against the same Layer (used only
 * for seams the public surface does not expose, e.g. the P2/P3 execution
 * runner drive for Work executions). */
export interface PublicAppHandle {
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly postCommand: (
    envelope: Record<string, unknown>,
  ) => Promise<{ status: number; payload: { ok: boolean; body?: unknown } }>;
  readonly tick: () => Promise<void>;
  readonly readTranscript: (params: {
    readonly workspaceId: string;
    readonly limit: number;
    readonly cursor?: string;
    readonly conversationOnly?: boolean;
  }) => Promise<PublicTranscriptPage>;
  // biome-ignore lint/suspicious/noExplicitAny: capability harness erases the service context type
  readonly run: <A>(effect: Effect.Effect<A, unknown, any>) => Promise<A>;
  readonly close: () => Promise<void>;
}

export const withPublicConversationApp = async (
  input: {
    readonly databaseFile: string;
    readonly project: PublicProject;
    readonly modelRef: string;
    readonly provider: OpenAISdkClient;
    readonly secretRef?: SecretRef;
  },
  body: (handle: PublicAppHandle) => Promise<void>,
): Promise<void> => {
  const projectId = parse(ProjectId)(input.project.projectId);
  const authenticator = makeStaticAuthenticator({
    [capabilityToken]: capabilityHuman,
  });
  const app = buildSliceLayer({
    databaseFile: input.databaseFile,
    projectId,
    modelCatalog: makeModelCatalog(input.modelRef),
    modelRef: input.modelRef,
    provider: { adapterId: "provider-openai", client: input.provider },
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
    authenticator,
    governance: {
      authenticatedHumans: [capabilityHuman],
      directParentOf: [],
    },
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          // Capture the fiber context once: every later Effect (tick, run)
          // reuses the same services — one SqlClient connection for the whole
          // handle lifetime. Rebuilding the layer per call would open a
          // second SQLite connection and deadlock both writers on the same
          // database file.
          const context = yield* Effect.context<never>() as Effect.Effect<
            Context.Context<never>,
            never,
            never
          >;
          const provideApp = <A, E>(
            // biome-ignore lint/suspicious/noExplicitAny: capability harness erases the service context type
            effect: Effect.Effect<A, E, any>,
          ): Effect.Effect<A, E, never> =>
            Effect.provideContext(
              effect as Effect.Effect<A, E, never>,
              context,
            );
          yield* runMigrations(CURRENT_MIGRATIONS);
          const boundary = yield* TransportBoundary;
          const sql = yield* SqlClient;
          const daemon = yield* ProductionDaemonService;
          yield* daemon.daemon.start;
          const server = yield* Effect.promise(() =>
            startWebTransport({
              http: boundary.http,
              webSocket: boundary.webSocket,
              sql,
              projectDirectory: { list: () => Effect.succeed([]) },
              pollIntervalMs: 60_000,
            }),
          );
          const base = `http://127.0.0.1:${server.port}`;
          const headers = {
            "content-type": "application/json",
            authorization: `Bearer ${capabilityToken}`,
          };
          const handle: PublicAppHandle = {
            base,
            headers,
            postCommand: (envelope) =>
              Effect.runPromise(
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
                      body?: unknown;
                    },
                  };
                }),
              ),
            tick: () =>
              Effect.runPromise(provideApp(daemon.daemon.conversationTick)),
            readTranscript: async (params) => {
              const response = await fetch(`${base}/views/transcript`, {
                method: "POST",
                headers,
                body: JSON.stringify(params),
              });
              if (response.status !== 200) {
                throw new Error(
                  `public transcript read failed: ${response.status}`,
                );
              }
              const payload = (await response.json()) as {
                readonly ok: boolean;
                readonly body: { readonly value: PublicTranscriptPage };
              };
              if (!payload.ok) {
                throw new Error("public transcript returned a problem");
              }
              return payload.body.value;
            },
            // biome-ignore lint/suspicious/noExplicitAny: capability harness erases the service context type
            run: <A2>(effect: Effect.Effect<A2, unknown, any>) =>
              Effect.runPromise(provideApp(effect)),
            close: () =>
              Effect.runPromise(Effect.promise(() => server.close())),
          };
          try {
            yield* Effect.promise(() => body(handle));
          } finally {
            yield* Effect.promise(() => server.close());
          }
        }),
        app,
      ),
    ),
  );
};

export const runPublicConversation = async (input: {
  readonly databaseFile: string;
  readonly project: PublicProject;
  readonly modelRef: string;
  readonly provider: OpenAISdkClient;
  readonly secretRef?: SecretRef;
  readonly turns: ReadonlyArray<PublicConversationTurn>;
}): Promise<PublicConversationResult> => {
  const transcripts: Array<{
    entries: ReadonlyArray<{
      kind: string;
      body: string;
      messageId?: string;
      executionId?: string;
    }>;
  }> = [];
  await withPublicConversationApp(input, async (handle) => {
    const createProject = await handle.postCommand(
      commandEnvelope(input.project.projectId, "CreateProject", input.project),
    );
    if (
      createProject.status !== 200 ||
      (createProject.payload.body as { resolution?: string } | undefined)
        ?.resolution !== "Committed"
    ) {
      throw new Error(
        `public CreateProject failed: ${createProject.status} ${JSON.stringify(createProject.payload)}`,
      );
    }

    for (const turn of input.turns) {
      const messageId = prefixedId("msg");
      const envelope = commandEnvelope(
        input.project.projectId,
        "SubmitHumanMessage",
        {
          messageId,
          targetWorkspaceId: input.project.rootWorkspaceId,
          bodyRef: turn.body,
        },
      );
      const submitted = await handle.postCommand(envelope);
      if (
        submitted.status !== 200 ||
        (submitted.payload.body as { resolution?: string } | undefined)
          ?.resolution !== "Committed"
      ) {
        throw new Error(
          `public SubmitHumanMessage failed: ${submitted.status} ${JSON.stringify(submitted.payload)}`,
        );
      }
      if (turn.duplicateSubmission === true) {
        const duplicate = await handle.postCommand(envelope);
        if (
          duplicate.status !== 200 ||
          (duplicate.payload.body as { resolution?: string } | undefined)
            ?.resolution !== "Committed"
        ) {
          throw new Error(
            `duplicate SubmitHumanMessage failed: ${duplicate.status} ${JSON.stringify(duplicate.payload)}`,
          );
        }
      }

      // One tick admits and runs the coordination execution; the
      // following tick performs the durable response-body writeback.
      await handle.tick();
      await handle.tick();

      transcripts.push(
        await handle.readTranscript({
          workspaceId: input.project.rootWorkspaceId,
          limit: 20,
        }),
      );
    }
  });
  return {
    projectId: input.project.projectId,
    transcripts,
  };
};

export const responseBodyFrom = (
  transcript: PublicConversationResult["transcripts"][number],
): ReadonlyArray<string> =>
  transcript.entries
    .filter((entry) => entry.kind === "AssistantConversationTurn")
    .map((entry) => entry.body);
