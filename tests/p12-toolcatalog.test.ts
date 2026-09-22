import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  type ContextFragment,
  type InstructionFragment,
  ModelContext,
  ModelContextLive,
  WORK_EXECUTION_PROGRAM,
} from "../packages/model-context/src/index.js";
import {
  ModelCapabilityPort,
  type ModelFacingToolDefinition,
  SkillRegistry,
  type ToolCatalogError,
  ToolCatalogPort,
  type ToolDefinitionRef,
} from "../packages/ports/src/index.js";
import {
  BUILTIN_TOOLS,
  READ_DEFINITION,
  ToolCatalogPortLive,
} from "../packages/tool-runtime/src/index.js";

/**
 * P12-007 (`07` §2–§4; EC-8 / blocker B2; CI-6):
 *  - `visibleRefs` is the renamed inherited `definitions()` surface (Effect
 *    channel retained) and an unregistered ref is absent from it;
 *  - `resolveForModel` projects the real model-facing `ToolDefinition`
 *    (description / schemaJson := inputSchemaJson / version / hash /
 *    capabilityMetadata / sideEffectSemantics);
 *  - `resolveForModel(unregistered)` fails with typed `ToolNotRegistered`;
 *  - the compiler emits the real description/schema, never the
 *    `description:name` / `schemaJson:"{}"` placeholder.
 */

const refOf = (name: string): ToolDefinitionRef => {
  const found = BUILTIN_TOOLS.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(`unknown builtin tool: ${name}`);
  }
  return { name: found.name, version: found.version, hash: found.hash };
};

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
  load: () => Effect.die("no skills in test"),
});

const app = Layer.mergeAll(
  capability,
  skills,
  ToolCatalogPortLive,
  Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, skills, ToolCatalogPortLive),
  ),
);

const fragment = (
  identity: string,
  authorityRole: InstructionFragment["authorityRole"],
  contentRef = identity,
): InstructionFragment => ({
  identity,
  revision: 1,
  hash: "h",
  semanticKind: "K",
  source: "Canonical",
  scope: identity,
  authorityRole,
  strength: authorityRole <= "A3" ? "Hard" : "Soft",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Pinned",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef,
});

const input = () => ({
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
  fragments: [fragment("work-objective", "A3")],
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
});

const withCatalog = <A>(
  program: Effect.Effect<A, unknown, ToolCatalogPort>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, ToolCatalogPortLive) as never);

describe("P12-007 ToolCatalogPort model-facing resolution", () => {
  it("projects the full model-facing ToolDefinition for a visible ref", async () => {
    const projection = await withCatalog(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalogPort;
        return yield* catalog.resolveForModel(refOf("read"));
      }),
    );
    const resolved: ModelFacingToolDefinition = projection;
    expect(resolved).toEqual({
      name: READ_DEFINITION.name,
      description: READ_DEFINITION.description,
      schemaJson: READ_DEFINITION.inputSchemaJson,
      version: READ_DEFINITION.version,
      hash: READ_DEFINITION.hash,
      capabilityMetadata: READ_DEFINITION.capabilityMetadata,
      sideEffectSemantics: READ_DEFINITION.sideEffectSemantics,
    });
    // schemaJson is the input schema, never the placeholder "{}".
    expect(resolved.schemaJson).not.toBe("{}");
    // description is the real description, never the name placeholder.
    expect(resolved.description).not.toBe(resolved.name);
  });

  it("visibleRefs is an Effect-returning surface; unregistered ref absent", async () => {
    const refs = await withCatalog(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalogPort;
        return yield* catalog.visibleRefs();
      }),
    );
    expect(refs.map((ref) => ref.name).sort()).toEqual([
      "patch",
      "read",
      "shell",
    ]);
    expect(refs.some((ref) => ref.name === "ghost")).toBe(false);
  });

  it("resolveForModel(unregistered) -> typed ToolNotRegistered (no placeholder)", async () => {
    const ghost: ToolDefinitionRef = {
      name: "ghost",
      version: "1",
      hash: "ghost-v1",
    };
    const error = (await withCatalog(
      Effect.gen(function* () {
        const catalog = yield* ToolCatalogPort;
        return yield* Effect.flip(catalog.resolveForModel(ghost));
      }),
    )) as ToolCatalogError;
    expect(error._tag).toBe("ToolNotRegistered");
    if (error._tag === "ToolNotRegistered") {
      expect(error.ref).toEqual(ghost);
    }
  });
});

describe("P12-007 compiler emits real tool metadata (CI-6)", () => {
  it("compiled PortableModelRequest.toolDefinitions carries real description/schema/version, no placeholder", async () => {
    const prepared = (await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const modelContext = yield* ModelContext;
          return yield* modelContext.prepareTurn(input() as never);
        }),
        app,
      ) as never,
    )) as {
      _tag: string;
      turn: {
        request: {
          toolDefinitions: ReadonlyArray<{
            name: string;
            description: string;
            schemaJson: string;
          }>;
        };
      };
    };

    expect(prepared._tag).toBe("Ready");
    const byName = Object.fromEntries(
      prepared.turn.request.toolDefinitions.map((tool) => [tool.name, tool]),
    );
    expect(Object.keys(byName).sort()).toEqual(["patch", "read", "shell"]);
    for (const builtin of BUILTIN_TOOLS) {
      const compiled = byName[builtin.name];
      expect(compiled).toBeDefined();
      expect(compiled?.description).toBe(builtin.description);
      expect(compiled?.schemaJson).toBe(builtin.inputSchemaJson);
      expect(compiled?.description).not.toBe(builtin.name);
      expect(compiled?.schemaJson).not.toBe("{}");
    }
  });
});
