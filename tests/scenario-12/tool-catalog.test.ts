import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  layer,
  P12_MIGRATIONS,
  ProjectToolRegistryLive,
  runMigrations,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  type ContextFragment,
  canonicalInstructionTrust,
  hashInstructionContent,
  type InstructionFragment,
  ModelContext,
  ModelContextLive,
  WORK_EXECUTION_PROGRAM,
} from "../../packages/model-context/src/index.js";
import {
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  ProjectToolRegistry,
  SkillRegistry,
  ToolCatalogPort,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  BUILTIN_TOOLS,
  ToolCatalogPortLive,
} from "../../packages/tool-runtime/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "../support/legacy-project-resource-source.js";
import { ECHO_DEFINITION, PLUGIN, PROJECT, VERSION } from "./support.js";

// ---------------------------------------------------------------------------
// story 8 (`07`): model-facing ToolCatalogPort; compiled request carries real metadata
// ---------------------------------------------------------------------------

const story8Input = (
  executableTools: ReadonlyArray<
    import("../../packages/ports/src/index.js").ModelFacingToolDefinition
  >,
) => ({
  executionId: parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  contextEpoch: parse(ContextEpochNumber)(0),
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ),
  binding: {
    _tag: "ResponsibilityBoundAgentBinding" as const,
    workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  },
  workspaceId: parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1"),
  cognitiveMode: "execute",
  program: WORK_EXECUTION_PROGRAM,
  fragments: [
    {
      identity: "work-objective",
      revision: 1,
      hash: hashInstructionContent("Wave 1 tool catalog objective body"),
      semanticKind: "K",
      source: "Canonical",
      scope: "work-objective",
      authorityRole: "A3",
      strength: "Hard",
      compositionMode: "Constrain",
      activationCondition: "always",
      lifetime: "Pinned",
      cacheClass: "Stable",
      budgetClass: "b",
      modelCompatibility: [],
      contentRef: "work-objective",
      provenance: canonicalInstructionTrust,
    } satisfies InstructionFragment,
  ],
  instructionContents: new Map([
    ["work-objective", "Wave 1 tool catalog objective body"],
  ]),
  contextFragments: [] as ReadonlyArray<ContextFragment>,
  budget: {
    modelWindow: 4000,
    outputReserve: 512,
    protocolReserve: 100,
    toolReserve: 100,
  },
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "d",
    environmentRevision: "e",
  },
  maxOutputTokens: 128,
  bodySkillIds: [],
  turnProfile: {
    purpose: "WorkspaceWork" as const,
    profileVersion: "turn-profile-v1" as const,
    outputContractRef: "tool-invocation-v1",
    executableTools,
    controlTools: [],
    contextPolicyRef: "workspace-work-context-v1",
    fingerprint: "tpf_p12_acceptance",
  },
});

describe("-acceptance story 8 — model-facing tool catalog in the compiled request", () => {
  it("story 8: the compiled PortableModelRequest carries the real project tool metadata (no placeholder)", async () => {
    const base = layer({ filename: ":memory:" });
    const registry = Layer.provide(ProjectToolRegistryLive, base);
    const tx = Layer.provide(TransactionPortLive, base);
    const catalog = Layer.provide(
      ToolCatalogPortLive({ projectId: PROJECT }),
      registry,
    );
    const capability = Layer.succeed(ModelCapabilityPort, {
      resolve: () =>
        Effect.succeed({
          modelRef: "model-a",
          family: "family-a",
          contextWindow: 4000,
          outputCeiling: 512,
          toolProtocol: "json",
        }),
    });
    const skills = Layer.succeed(SkillRegistry, {
      available: () => Effect.succeed([]),
      load: () => Effect.die("no skills"),
    });
    const modelContext = Layer.provide(
      ModelContextLive,
      Layer.mergeAll(capability, skills, catalog),
    );
    const app = Layer.mergeAll(base, registry, tx, catalog, modelContext);

    const prepared = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P12_MIGRATIONS);
          yield* ensureLegacyProjectResourceSourceFixture();
          const txPort = yield* TransactionPort;
          const reg = yield* ProjectToolRegistry;
          yield* txPort.transact(
            reg.register({
              projectId: PROJECT,
              pluginId: PLUGIN,
              pluginVersion: VERSION,
              contentHash: "story-8-content-hash",
              definitions: [ECHO_DEFINITION],
            }),
          );
          const toolCatalog = yield* ToolCatalogPort;
          const executableTools: ModelFacingToolDefinition[] = [];
          for (const ref of yield* toolCatalog.visibleRefs()) {
            executableTools.push(yield* toolCatalog.resolveForModel(ref));
          }
          const modelContextPort = yield* ModelContext;
          return yield* modelContextPort.prepareTurn(
            story8Input(executableTools) as never,
          );
        }),
        app,
      ) as never,
    );

    const turn = prepared as {
      readonly _tag: string;
      readonly turn: {
        readonly request: {
          readonly toolDefinitions: ReadonlyArray<{
            readonly name: string;
            readonly description: string;
            readonly schemaJson: string;
          }>;
        };
      };
    };
    expect(turn._tag).toBe("Ready");
    const compiled = turn.turn.request.toolDefinitions.find(
      (tool) => tool.name === ECHO_DEFINITION.name,
    );
    expect(compiled).toBeDefined();
    expect(compiled?.description).toBe(ECHO_DEFINITION.description);
    expect(compiled?.schemaJson).toBe(ECHO_DEFINITION.inputSchemaJson);
    expect(compiled?.description).not.toBe(ECHO_DEFINITION.name);
    expect(compiled?.schemaJson).not.toBe("{}");
    for (const builtin of BUILTIN_TOOLS.filter(
      ({ name }) =>
        name !== "shell" &&
        (process.platform === "linux" ||
          !["write", "glob", "grep"].includes(name)),
    )) {
      expect(
        turn.turn.request.toolDefinitions.some(
          (tool) => tool.name === builtin.name,
        ),
      ).toBe(true);
    }
    expect(
      turn.turn.request.toolDefinitions.some((tool) => tool.name === "shell"),
    ).toBe(false);
  });
});
